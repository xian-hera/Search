import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  SHOP_DOMAIN,
  SHOP_ACCESS_TOKEN,
  QR_SECRET,
} = process.env;

const SCOPES = "read_products,read_inventory,read_customers";

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

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
      loyaltyPoints: metafield(namespace: "loyalty", key: "points") {
        value
      }
    }
  }
`;

app.post("/api/verify", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Missing token" });

  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return res.status(400).json({ error: "Invalid token format" });

  const payloadB64 = token.slice(0, lastDot);
  const receivedHmac = token.slice(lastDot + 1);

  const expectedHmac = crypto
    .createHmac("sha256", QR_SECRET)
    .update(payloadB64)
    .digest("hex");

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(receivedHmac, "hex"),
      Buffer.from(expectedHmac, "hex")
    );
  } catch {
    return res.status(401).json({ error: "Invalid signature" });
  }

  if (!valid) return res.status(401).json({ error: "Invalid signature" });

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Malformed payload" });
  }

  const { customer_id } = payload;

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