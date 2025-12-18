const express = require("express");
const axios = require("axios");

const router = express.Router();

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_NAME;  
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;  
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-04";

if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
  console.warn(
    "Missing SHOPIFY_STORE_NAME or SHOPIFY_ACCESS_TOKEN in env."
  );
}

function parseLinkHeader(linkHeader = "") { 
  const links = {};
  const parts = linkHeader.split(",");
  for (const p of parts) {
    const section = p.split(";");
    if (section.length < 2) continue;
    const url = section[0].trim().replace(/^<|>$/g, "");
    const rel = section[1].trim().match(/rel="(.+)"/);
    if (rel && rel[1]) links[rel[1]] = url;
  }
  return links;
}

function variantAvailable(v) { 
  const qty = Number(v.inventory_quantity ?? 0);
  const policy = v.inventory_policy;  
  return qty > 0 || policy === "continue";
}

async function fetchAllActiveProducts() {
  const base = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/products.json`;

  let url = `${base}?limit=250&status=active`;  
  const out = [];

  while (url) {
    const res = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    const products = res.data?.products || [];
    out.push(...products);

    const link = res.headers?.link || "";
    const parsed = parseLinkHeader(link);
    url = parsed.next || null;
  }

  return out;
}

// GET /api/utm/shopify-products
router.get("/shopify-products", async (req, res) => {
  try {
    const products = await fetchAllActiveProducts();

    const cleaned = products
      .filter((p) => p && p.handle && Array.isArray(p.variants))
      .map((p) => ({
        productId: String(p.id),
        title: p.title || "",
        handle: p.handle || "",
        variants: (p.variants || []).map((v) => ({
          variantId: String(v.id),
          title: v.title || "Default",
          price: String(v.price ?? ""),
          available: variantAvailable(v),
        })),
      })) 
      .filter((p) => p.variants.length > 0);

    res.json(cleaned);
  } catch (err) {
    console.error("GET /api/utm/shopify-products error:", err?.response?.data || err);
    res.status(500).json({
      message: "Failed to fetch Shopify products",
      hint:
        "Check SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN, API version, and app scopes (read_products).",
    });
  }
});

module.exports = router;
 