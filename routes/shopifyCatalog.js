const express = require("express");
const axios = require("axios");

const router = express.Router();

const rawShop = (process.env.SHOPIFY_STORE_NAME || "").trim();
const SHOPIFY_SHOP = rawShop.includes(".myshopify.com")
  ? rawShop
  : `${rawShop}.myshopify.com`;

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

const SHOPIFY_GRAPHQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const response = await axios.post(
    SHOPIFY_GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      timeout: 30000,
    }
  );

  if (response.data?.errors?.length) {
    throw new Error(response.data.errors.map((e) => e.message).join(", "));
  }

  return response.data.data;
}

router.get("/products", async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 50);

    const query = `
      query GetProducts($first: Int!, $search: String) {
        products(first: $first, query: $search, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              legacyResourceId
              title
              handle
              status
              featuredImage {
                url
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    legacyResourceId
                    title
                    displayName
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                    availableForSale
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, {
      first: limit,
      search: search || null,
    });

    const products = (data.products.edges || []).map(({ node }) => ({
      id: node.id,
      productId: String(node.legacyResourceId || ""),
      title: node.title,
      handle: node.handle,
      status: node.status,
      image: node.featuredImage?.url || "",
      variants: (node.variants?.edges || []).map(({ node: variant }) => ({
        id: variant.id,
        variantId: String(variant.legacyResourceId || ""),
        title: variant.title,
        displayName: variant.displayName,
        sku: variant.sku || "",
        price: variant.price || "0",
        compareAtPrice: variant.compareAtPrice || "",
        inventoryQuantity: variant.inventoryQuantity ?? 0,
        availableForSale: Boolean(variant.availableForSale),
        image: variant.image?.url || node.featuredImage?.url || "",
        selectedOptions: (variant.selectedOptions || []).map((x) => ({
          name: x.name,
          value: x.value,
        })),
      })),
    }));

    return res.json({
      ok: true,
      products,
    });
  } catch (error) {
    console.error("shopify products route error:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      message:
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        "Failed to fetch Shopify products",
    });
  }
});

module.exports = router;