import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { PKPass } from "passkit-generator";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Raw body needed for Shopify webhook HMAC validation
app.use("/webhooks", express.raw({ type: "application/json" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  SHOP_DOMAIN,
  SHOP_ACCESS_TOKEN,
  QR_SECRET,
  SMILE_API_KEY,
} = process.env;

const SCOPES = "read_products,read_inventory,read_customers,write_customers,read_orders";

// ─── Apple Wallet certificates (from environment variables) ───────────────────
const wwdr       = Buffer.from(process.env.WWDR_PEM_B64, "base64");
const signerCert = Buffer.from(process.env.SIGNER_CERT_B64, "base64");
const signerKey  = Buffer.from(process.env.SIGNER_KEY_B64, "base64");

// ─── Product cache ────────────────────────────────────────────────────────────

let variantCache = [];
let cacheBuiltAt = null;
let cacheBuilding = false;

const PRODUCTS_QUERY = `
  query GetVariants($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        featuredImage { url }
        wigNumber: metafield(namespace: "custom", key: "wig_number") { value }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            image { url }
            customName: metafield(namespace: "custom", key: "name") { value }
            displaySection: metafield(namespace: "custom", key: "display_section") { value }
          }
        }
      }
    }
  }
`;

async function shopifyGraphQL(query, variables = {}) {
  const resp = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2025-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOP_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
  const json = await resp.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(", "));
  return json.data;
}

async function buildCache() {
  if (cacheBuilding) return;
  cacheBuilding = true;
  console.log("Building product cache...");
  try {
    const flat = [];
    let cursor = null;
    let hasNext = true;
    while (hasNext) {
      const data = await shopifyGraphQL(PRODUCTS_QUERY, cursor ? { cursor } : {});
      const page = data.products;
      for (const product of page.nodes) {
        const productImage = product.featuredImage?.url || null;
        const wigNumber = product.wigNumber?.value || "";
        for (const variant of product.variants.nodes) {
          flat.push({
            variantId: variant.id,
            productId: product.id,
            variantNumericId: variant.id.split("/").pop(),
            productNumericId: product.id.split("/").pop(),
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku || "",
            price: variant.price,
            customName: variant.customName?.value || "",
            wigNumber,
            displaySection: variant.displaySection?.value || "",
            imageUrl: variant.image?.url || productImage || null,
          });
        }
      }
      hasNext = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }
    variantCache = flat;
    cacheBuiltAt = new Date();
    console.log(`Cache built: ${flat.length} variants`);
  } catch (err) {
    console.error("Cache build failed:", err.message);
  } finally {
    cacheBuilding = false;
  }
}

buildCache();
setInterval(buildCache, 12 * 60 * 60 * 1000);

function normalise(str) {
  if (!str) return "";
  return str.toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function variantMatchesSingle(variant, kw) {
  return (
    normalise(variant.customName).includes(kw) ||
    normalise(variant.productTitle).includes(kw) ||
    normalise(variant.sku).includes(kw) ||
    normalise(variant.wigNumber).includes(kw)
  );
}

function variantMatchesAll(variant, tokens) {
  return tokens.every(t => variantMatchesSingle(variant, t));
}

function scoreVariant(variant, kw) {
  if (normalise(variant.customName).includes(kw)) return 0;
  if (normalise(variant.productTitle).includes(kw)) return 1;
  if (normalise(variant.sku).includes(kw)) return 2;
  if (normalise(variant.wigNumber).includes(kw)) return 3;
  return 4;
}

// ─── Token builder (numeric, compact) ────────────────────────────────────────

function buildToken(customerId) {
  const ts = Date.now().toString().slice(-6);
  const hmacHex = crypto
    .createHmac("sha256", QR_SECRET)
    .update(`${customerId}${ts}`)
    .digest("hex");
  const numericHmac = (parseInt(hmacHex.slice(0, 8), 16) % 100000000).toString().padStart(8, "0");
  return `${customerId}${ts}${numericHmac}`;
}

function verifyToken(token, customerId) {
  const idLen = customerId.toString().length;
  const ts = token.slice(idLen, idLen + 6);
  const receivedHmac = token.slice(idLen + 6);
  const hmacHex = crypto
    .createHmac("sha256", QR_SECRET)
    .update(`${customerId}${ts}`)
    .digest("hex");
  const expectedHmac = (parseInt(hmacHex.slice(0, 8), 16) % 100000000).toString().padStart(8, "0");
  return receivedHmac === expectedHmac;
}

// ─── Pass builder helper ──────────────────────────────────────────────────────

const PASS_CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      loyaltyPoints: metafield(namespace: "custom", key: "points_balance") {
        value
      }
    }
  }
`;

async function generatePassBuffer(customerId) {
  const gid = `gid://shopify/Customer/${customerId}`;
  const data = await shopifyGraphQL(PASS_CUSTOMER_QUERY, { id: gid });
  const customer = data.customer;
  if (!customer) throw new Error("Customer not found");

  const points = customer.loyaltyPoints?.value ?? "0";
  const token = buildToken(customerId);

  const pass = await PKPass.from({
    model: join(__dirname, "passkit/loyalty.pass"),
    certificates: { wwdr, signerCert, signerKey },
  }, {
    serialNumber: `hera-${customerId}`,
  });

  pass.type = "storeCard";

  pass.setBarcodes({
    message: token,
    format: "PKBarcodeFormatPDF417",
    messageEncoding: "iso-8859-1",
  });

  pass.primaryFields.push({ key: "points", label: "Points", value: points });
  pass.secondaryFields.push({ key: "name", label: "Member", value: `${customer.firstName} ${customer.lastName}` });

  return pass.getAsBuffer();
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── Search endpoint ──────────────────────────────────────────────────────────

const MAX_RESULTS = 200;

app.get("/search", (req, res) => {
  const { q } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_RESULTS);

  if (!q || q.trim().length < 2) {
    return res.json({ results: [], total: variantCache.length, cacheBuiltAt });
  }

  const kw = normalise(q.trim());
  const tokens = kw.split(/\s+/).filter(Boolean);

  const phraseMatches = variantCache.filter(v => variantMatchesSingle(v, kw));

  let results;
  if (phraseMatches.length > 0) {
    results = phraseMatches.sort((a, b) => scoreVariant(a, kw) - scoreVariant(b, kw));
  } else if (tokens.length > 1) {
    const multiMatches = variantCache.filter(v => variantMatchesAll(v, tokens));
    results = multiMatches.sort((a, b) => {
      const sa = Math.min(...tokens.map(t => scoreVariant(a, t)));
      const sb = Math.min(...tokens.map(t => scoreVariant(b, t)));
      return sa - sb;
    });
  } else {
    results = [];
  }

  res.json({
    results: results.slice(0, limit),
    total: variantCache.length,
    cacheBuiltAt,
  });
});

// ─── Variant inventory endpoint ───────────────────────────────────────────────

const INVENTORY_QUERY = `
  query GetVariantInventory($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      price
      inventoryItem {
        inventoryLevels(first: 50) {
          nodes {
            quantities(names: ["available"]) {
              name
              quantity
            }
            location {
              id
              name
            }
          }
        }
      }
    }
  }
`;

app.get("/variant/:id", async (req, res) => {
  const variantGid = `gid://shopify/ProductVariant/${req.params.id}`;
  try {
    const data = await shopifyGraphQL(INVENTORY_QUERY, { id: variantGid });
    const variant = data.productVariant;
    if (!variant) return res.status(404).json({ error: "Variant not found" });
    const locations = variant.inventoryItem.inventoryLevels.nodes.map((level) => ({
      locationId: level.location.id.split("/").pop(),
      locationName: level.location.name,
      available: level.quantities.find(q => q.name === "available")?.quantity ?? 0,
    }));
    res.json({
      variantId: req.params.id,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      locations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Customer QR verify ───────────────────────────────────────────────────────

const CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      email
      phone
      loyaltyPoints: metafield(namespace: "custom", key: "points_balance") {
        value
      }
    }
  }
`;

app.post("/api/verify", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Missing token" });

  if (token.length < 22) return res.status(400).json({ error: "Invalid token format" });

  const customer_id = token.slice(0, -14);

  if (!customer_id) return res.status(400).json({ error: "Invalid token format" });

  if (!verifyToken(token, customer_id)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  try {
    const gid = `gid://shopify/Customer/${customer_id}`;
    const data = await shopifyGraphQL(CUSTOMER_QUERY, { id: gid });
    const customer = data.customer;
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    return res.json({
      customerId: customer_id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      loyaltyPoints: customer.loyaltyPoints?.value ?? "0",
    });
  } catch (err) {
    return res.status(500).json({ error: "Customer lookup failed" });
  }
});

// ─── Apple Wallet Pass generate ───────────────────────────────────────────────

app.get("/api/pass/generate/:customerId", async (req, res) => {
  const { customerId } = req.params;
  if (!customerId) return res.status(400).json({ error: "Missing customerId" });

  try {
    const buffer = await generatePassBuffer(customerId);
    res.set({
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
    });
    res.send(buffer);
  } catch (err) {
    console.error("Pass generation failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Apple Wallet landing page ────────────────────────────────────────────────

app.get("/wallet/:customerId", (req, res) => {
  const { customerId } = req.params;
  const ua = req.headers["user-agent"] || "";
  const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/CriOS/.test(ua) && !/FxiOS/.test(ua);

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hera Beauté Loyalty Card</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #ffffff;
      padding: 24px;
      text-align: center;
    }
    .logo { width: 200px; margin-bottom: 48px; }
    .btn { background: none; border: none; cursor: pointer; padding: 0; margin-top: 24px; }
    .btn img { width: 180px; }
    .notice {
      font-size: 13px;
      color: #888;
      line-height: 1.6;
      max-width: 280px;
      margin-bottom: 8px;
    }
    .arrow {
      font-size: 28px;
      position: fixed;
      top: 12px;
      right: 16px;
      animation: bounce 1s infinite;
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-6px); }
    }
  </style>
</head>
<body>
  <img class="logo" src="https://cdn.shopify.com/s/files/1/1443/5388/files/Logo_bdd93355-62cf-412d-81f4-6b24fc343bf7.svg?v=1761925608" alt="Hera Beauté">

  ${!isSafari ? `
  <div class="arrow">↗</div>
  <p class="notice">
    Please open this page in Safari to add your card.<br>
    Veuillez ouvrir cette page dans Safari pour ajouter votre carte.
  </p>
  ` : ""}

  <button class="btn" onclick="window.location.href='/api/pass/generate/${customerId}'">
    <img src="https://cdn.shopify.com/s/files/1/1443/5388/files/add_button.png?v=1778255486" alt="Add to Apple Wallet">
  </button>
</body>
</html>`);
});

// ─── Shopify orders/paid webhook → sync Smile points to metafield ─────────────

app.post("/webhooks/orders", async (req, res) => {
  // Verify Shopify HMAC
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(req.body)
    .digest("base64");

  if (digest !== hmacHeader) {
    console.warn("Webhook HMAC mismatch");
    return res.status(401).send("Unauthorized");
  }

  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const shopifyCustomerId = order.customer?.id;
  if (!shopifyCustomerId) return res.status(200).send("No customer");

  res.status(200).send("OK");

  // Run sync in background after responding
  syncSmilePoints(shopifyCustomerId).catch(err =>
    console.error("Smile sync error:", err.message)
  );
});

async function syncSmilePoints(shopifyCustomerId) {
  // 1. Find Smile customer by Shopify customer ID
  const smileResp = await fetch(
    `https://api.smile.io/v1/customers?shopify_customer_id=${shopifyCustomerId}`,
    { headers: { Authorization: `Bearer ${SMILE_API_KEY}` } }
  );

  if (!smileResp.ok) {
    console.error(`Smile API error: ${smileResp.status}`);
    return;
  }

  const smileData = await smileResp.json();
  const smileCustomer = smileData.customers?.[0];

  if (!smileCustomer) {
    console.log(`No Smile customer found for Shopify ID ${shopifyCustomerId}`);
    return;
  }

  const pointsBalance = smileCustomer.points_balance ?? 0;
  console.log(`Syncing Smile points for customer ${shopifyCustomerId}: ${pointsBalance}`);

  // 2. Write points to Shopify metafield
  const metafieldResp = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2025-07/customers/${shopifyCustomerId}/metafields.json`,
    { headers: { "X-Shopify-Access-Token": SHOP_ACCESS_TOKEN } }
  );

  const metafieldData = await metafieldResp.json();
  const existing = metafieldData.metafields?.find(
    m => m.namespace === "custom" && m.key === "points_balance"
  );

  const body = {
    metafield: {
      namespace: "custom",
      key: "points_balance",
      value: String(pointsBalance),
      type: "number_integer",
    },
  };

  if (existing?.id) {
    await fetch(
      `https://${SHOP_DOMAIN}/admin/api/2025-07/customers/${shopifyCustomerId}/metafields/${existing.id}.json`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOP_ACCESS_TOKEN,
        },
        body: JSON.stringify(body),
      }
    );
  } else {
    await fetch(
      `https://${SHOP_DOMAIN}/admin/api/2025-07/customers/${shopifyCustomerId}/metafields.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOP_ACCESS_TOKEN,
        },
        body: JSON.stringify(body),
      }
    );
  }

  console.log(`Updated points_balance to ${pointsBalance} for customer ${shopifyCustomerId}`);
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code, hmac, state, ...rest } = req.query;
  const params = Object.entries({ shop, code, state, ...rest })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(params).digest("hex");
  if (digest !== hmac) return res.status(403).send("HMAC validation failed");
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }),
  });
  const { access_token } = await tokenRes.json();
  console.log(`Installed on ${shop}: ${access_token}`);
  res.redirect(`https://${shop}/admin/apps`);
});

// ─── Cache utils ──────────────────────────────────────────────────────────────

app.get("/cache/refresh", (req, res) => {
  buildCache();
  res.json({ message: "Cache refresh started" });
});

app.get("/cache/status", (req, res) => {
  res.json({ total: variantCache.length, cacheBuiltAt, cacheBuilding });
});

app.get("/", (req, res) => res.send("Search POS OK"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));