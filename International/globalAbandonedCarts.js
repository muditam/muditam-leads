// routes/globalAbandonedCarts.js
const express = require("express");
const axios = require("axios");

const router = express.Router();

const {
  SHOPIFY_ACCESS_TOKEN_2,
  SHOPIFY_STORE_NAME_2,
} = process.env;

if (!SHOPIFY_ACCESS_TOKEN_2 || !SHOPIFY_STORE_NAME_2) {
  console.warn(
    "[globalAbandonedCarts] Missing SHOPIFY_ACCESS_TOKEN_2 or SHOPIFY_STORE_NAME_2 in environment."
  );
}

// Helper: fetch ALL abandoned checkouts from Shopify using cursor pagination
async function fetchAllAbandonedCheckouts(shop, token) {
  const basePath = `/admin/api/2024-01/checkouts.json`;
  const baseUrl = `https://${shop}.myshopify.com`;
  let url = `${baseUrl}${basePath}?limit=250&order=created_at%20desc`;

  let allCheckouts = [];
  let pageCount = 0;

  while (url) {
    pageCount += 1;
    console.log(
      `[globalAbandonedCarts] Fetching page ${pageCount} → ${url}`
    );

    const resp = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": token,
      },
    });

    const checkouts = resp.data.checkouts || [];
    allCheckouts = allCheckouts.concat(checkouts);

    const linkHeader = resp.headers["link"] || resp.headers["Link"];

    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match && match[1]) {
        url = match[1]; // full URL from Shopify
      } else {
        url = null;
      }
    } else {
      url = null;
    }
  }

  console.log(
    `[globalAbandonedCarts] Total abandoned checkouts fetched: ${allCheckouts.length}`
  );
  return allCheckouts;
}

/**
 * GET /api/global-aband
 * Query params:
 *   page  (1-based, default 1)
 *   limit (default 20, max 100)
 *
 * Returns: { page, limit, total, carts: [...] }
 */
router.get("/global-aband", async (req, res) => {
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

    // 🔁 Fetch ALL abandoned checkouts
    const allCheckouts = await fetchAllAbandonedCheckouts(
      shop,
      SHOPIFY_ACCESS_TOKEN_2
    );

    const total = allCheckouts.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const slice = allCheckouts.slice(start, end);

    const normalized = slice.map((c) => {
      // Name from shipping or billing if available
      const shippingName = c.shipping_address
        ? `${c.shipping_address.first_name || ""} ${
            c.shipping_address.last_name || ""
          }`.trim()
        : "";
      const billingName = c.billing_address
        ? `${c.billing_address.first_name || ""} ${
            c.billing_address.last_name || ""
          }`.trim()
        : "";

      const customerName = shippingName || billingName || c.email || "";

      const phone =
        c.phone ||
        (c.shipping_address && c.shipping_address.phone) ||
        (c.billing_address && c.billing_address.phone) ||
        "";

      const productsOrdered = (c.line_items || [])
        .map((li) => `${li.title} x${li.quantity}`)
        .join(", ");

      const channelName = c.source_name || "Online Store";

      const modeOfPayment = Array.isArray(c.payment_gateway_names)
        ? c.payment_gateway_names.join(", ")
        : "";

      return {
        id: c.id || c.token,
        orderName: c.name || `Checkout ${c.id || c.token}`, // might be undefined, so fallback
        customerName,
        contactNumber: phone,
        orderDate: c.created_at,
        amount: c.total_price || c.subtotal_price,
        modeOfPayment,
        productsOrdered,
        channelName,
        recoveryUrl: c.abandoned_checkout_url,
      };
    });

    res.json({
      page,
      limit,
      total,
      carts: normalized,
    });
  } catch (err) {
    console.error(
      "[global-aband] Error:",
      err.response?.data || err.message
    );
    res.status(500).json({
      message: "Failed to fetch global abandoned carts.",
      error: err.response?.data || err.message,
    });
  }
});

module.exports = router;
