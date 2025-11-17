// routes/globalShopifyOrders.js
const express = require("express");
const axios = require("axios");

const router = express.Router();

const {
  SHOPIFY_API_KEY_2,
  SHOPIFY_API_SECRET_2,
  SHOPIFY_ACCESS_TOKEN_2,
  SHOPIFY_STORE_NAME_2,
} = process.env;

// Basic sanity check so you don't go crazy debugging missing env vars
if (!SHOPIFY_ACCESS_TOKEN_2 || !SHOPIFY_STORE_NAME_2) {
  console.warn(
    "[globalShopifyOrders] Missing SHOPIFY_ACCESS_TOKEN_2 or SHOPIFY_STORE_NAME_2 in environment."
  );
}

// Helper: fetch ALL orders from Shopify using cursor pagination (page_info)
async function fetchAllShopifyOrders(shop, token) {
  const basePath = `/admin/api/2024-01/orders.json`;
  const baseUrl = `https://${shop}.myshopify.com`;
  let url = `${baseUrl}${basePath}?status=any&limit=250&order=created_at%20desc`;

  let allOrders = [];
  let pageCount = 0;

  while (url) {
    pageCount += 1;
    console.log(`[globalShopifyOrders] Fetching page ${pageCount} → ${url}`);

    const resp = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": token,
      },
    });

    const orders = resp.data.orders || [];
    allOrders = allOrders.concat(orders);

    const linkHeader = resp.headers["link"] || resp.headers["Link"];

    if (linkHeader && linkHeader.includes('rel="next"')) {
      // Extract the next page URL from the Link header
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match && match[1]) {
        // Shopify already gives full URL here, so we can just use it directly
        url = match[1];
      } else {
        url = null;
      }
    } else {
      url = null;
    }
  }

  console.log(
    `[globalShopifyOrders] Total orders fetched from Shopify: ${allOrders.length}`
  );
  return allOrders;
}

/**
 * GET /api/global-shopify-orders
 * Query params:
 *   page  (1-based, default 1)
 *   limit (default 20, max 100)
 *
 * Returns: { page, limit, total, orders: [...] }
 */
router.get("/global-shopify-orders", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limitRaw = parseInt(req.query.limit || "20", 10);
    const limit = Math.min(Math.max(limitRaw, 1), 100);

    if (!SHOPIFY_ACCESS_TOKEN_2 || !SHOPIFY_STORE_NAME_2) {
      return res.status(500).json({
        message:
          "Shopify credentials for global store (SHOPIFY_*_2) are not configured on the server.",
      });
    }

    const shop = SHOPIFY_STORE_NAME_2;

    // 🔁 Fetch ALL orders from Shopify (all pages)
    const allOrders = await fetchAllShopifyOrders(
      shop,
      SHOPIFY_ACCESS_TOKEN_2
    );

    // Server-side pagination on the full result
    const total = allOrders.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const slice = allOrders.slice(start, end);

    const normalized = slice.map((o) => {
      const customerName = o.customer
        ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim()
        : "";

      const phone =
        (o.customer && o.customer.phone) ||
        (o.billing_address && o.billing_address.phone) ||
        "";

      const productsOrdered = (o.line_items || [])
        .map((li) => `${li.title} x${li.quantity}`)
        .join(", ");

      const channelName =
        o.source_name ||
        (Array.isArray(o.payment_gateway_names) &&
          o.payment_gateway_names.join(", ")) ||
        "";

      const modeOfPayment =
        (Array.isArray(o.payment_gateway_names) &&
          o.payment_gateway_names[0]) ||
        o.gateway ||
        "";

      return {
        id: o.id,
        orderName: o.name, // e.g. #1001
        customerName,
        contactNumber: phone,
        orderDate: o.created_at,
        amount: o.current_total_price || o.total_price,
        modeOfPayment,
        productsOrdered,
        channelName,
      };
    });

    res.json({
      page,
      limit,
      total,
      orders: normalized,
    });
  } catch (err) {
    console.error(
      "[global-shopify-orders] Error:",
      err.response?.data || err.message
    );
    res.status(500).json({
      message: "Failed to fetch global Shopify orders.",
      error: err.response?.data || err.message,
    });
  }
});

module.exports = router;
