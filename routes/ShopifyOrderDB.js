const express = require("express");
const axios = require("axios");
const ShopifyOrder = require("../models/ShopifyOrder");

const router = express.Router();

// Optional: enforce TLS 1.2 (sometimes helps with Node+Shopify)
/// const https = require("https");
/// const tlsAgent = new https.Agent({ secureProtocol: "TLSv1_2_method" });

function shopifyBase(store) {
  return `https://${store}.myshopify.com/admin/api/2024-04`;
}

// RFC5988 Link header parser → returns { next: "...", previous: "..." }
function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  return linkHeader.split(",").reduce((acc, part) => {
    const [urlPart, relPart] = part.split(";").map(s => s.trim());
    const url = urlPart?.replace(/^<|>$/g, "");
    const rel = /rel="([^"]+)"/.exec(relPart || "")?.[1];
    if (url && rel) acc[rel] = url;
    return acc;
  }, {});
}

function preferAddress(o) {
  const a = o.shipping_address || o.customer?.default_address || null;
  if (!a) return null;
  return {
    name: a.name || [a.first_name, a.last_name].filter(Boolean).join(" ").trim(),
    phone: a.phone || "",
    address1: a.address1 || "",
    address2: a.address2 || "",
    city: a.city || "",
    province: a.province || "",
    zip: a.zip || "",
    country: a.country || "",
  };
}

function getContact(o) {
  // “their number from address line” → prefer address phones
  return (
    o.shipping_address?.phone ||
    o.customer?.default_address?.phone ||
    o.customer?.phone ||
    ""
  );
}

function mapOrder(o) {
  const products = (o.line_items || []).map(li => ({
    title: li.title,
    quantity: li.quantity,
    sku: li.sku || "",
    variant_id: li.variant_id,
    price: Number(li.price || 0),
  }));

  const paymentGatewayNames = Array.isArray(o.payment_gateway_names)
    ? o.payment_gateway_names
    : [];

  const contact = getContact(o);

  return {
    orderId: o.id,
    orderName: o.name || "",
    customerName:
      o.shipping_address?.name ||
      [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ").trim() ||
      o.customer?.default_address?.name ||
      "",
    contactNumber: contact || "",
    orderDate: o.created_at ? new Date(o.created_at) : null,
    amount: Number(o.total_price || 0),
    paymentGatewayNames,
    modeOfPayment:
      paymentGatewayNames[0] || (o.gateway ? String(o.gateway) : paymentGatewayNames.join(", ")),
    productsOrdered: products,
    channelName: o.source_name || "",
    customerAddress: preferAddress(o),
    currency: o.currency || "",
    financial_status: o.financial_status || "",
    fulfillment_status: o.fulfillment_status || "",
  };
}

/**
 * GET /api/orders/sync-all
 * Fetches **ALL** orders from Shopify (from the very first order) using page_info pagination.
 * Saves/updates them in Mongo (upsert by orderId).
 *
 * Optional query params:
 *   - limit: page size (default 250, max 250)
 */
router.get("/sync-all", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }

    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    let url = `${base}/orders.json?status=any&limit=${limit}`;
    const headers = {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    };

    let fetched = 0;
    let created = 0;
    let updated = 0;

    while (url) {
      const resp = await axios.get(url, { headers /*, httpsAgent: tlsAgent */ });
      const orders = resp.data?.orders || [];
      fetched += orders.length;

      // Upsert each order by Shopify numeric id
      for (const raw of orders) {
        const doc = mapOrder(raw);
        const resUp = await ShopifyOrder.updateOne(
          { orderId: doc.orderId },
          { $set: doc },
          { upsert: true }
        );
        if (resUp.upsertedCount) created += 1;
        else if (resUp.matchedCount) updated += 1;
      }

      const links = parseLinkHeader(resp.headers.link);
      url = links.next || null;
    }

    res.json({ ok: true, fetched, created, updated });
  } catch (err) {
    console.error("sync-all error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync all orders", details: err?.message || err });
  }
});

/**
 * GET /api/orders
 * List saved orders from Mongo with pagination/filters
 *   ?page=1&limit=50&phone=XXXXXXXXXX&source=web
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);

    const q = {};
    if (req.query.phone) {
      const digits = String(req.query.phone).replace(/\D/g, "");
      q.normalizedPhone = digits.length >= 10 ? digits.slice(-10) : digits;
    }
    if (req.query.source) q.channelName = String(req.query.source);

    const [data, total] = await Promise.all([
      ShopifyOrder.find(q).sort({ orderDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      ShopifyOrder.countDocuments(q),
    ]);

    res.json({ page, limit, total, data });
  } catch (err) {
    console.error("list orders error:", err);
    res.status(500).json({ error: "Failed to list orders" });
  }
});

module.exports = router;
