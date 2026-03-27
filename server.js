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
} = process.env;

const SCOPES = "read_products,read_inventory";

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
        variants(first: 100) {
          nodes {
            id
            title
            sku
            barcode
            price
            inventoryQuantity
            metafield(namespace: "custom", key: "name") { value }
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
        for (const variant of product.variants.nodes) {
          flat.push({
            variantId: variant.id,
            productId: product.id,
            variantNumericId: variant.id.split("/").pop(),
            productNumericId: product.id.split("/").pop(),
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku || "",
            barcode: variant.barcode || "",
            price: variant.price,
            inventoryQuantity: variant.inventoryQuantity ?? null,
            customName: variant.metafield?.value || "",
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
setInterval(buildCache, 60 * 60 * 1000);

// ─── Search helpers ───────────────────────────────────────────────────────────

function normalise(str) {
  if (!str) return "";
  return str.toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function variantMatches(variant, kw) {
  return (
    normalise(variant.productTitle).includes(kw) ||
    normalise(variant.variantTitle).includes(kw) ||
    normalise(variant.customName).includes(kw) ||
    normalise(variant.sku).includes(kw) ||
    normalise(variant.barcode).includes(kw)
  );
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get("/search", (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json({ results: [], total: variantCache.length, cacheBuiltAt });
  }
  const kw = normalise(q.trim());
  const limit = parseInt(req.query.limit) || 100;
  const results = variantCache.filter((v) => variantMatches(v, kw)).slice(0, limit);
  res.json({ results, total: variantCache.length, cacheBuiltAt });
});

app.post("/cache/refresh", (req, res) => {
  buildCache();
  res.json({ message: "Cache refresh started" });
});

app.get("/cache/status", (req, res) => {
  res.json({ total: variantCache.length, cacheBuiltAt, cacheBuilding });
});

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

app.get("/", (req, res) => res.send("Search POS OK"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));