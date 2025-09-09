const express = require("express");
const axios = require("axios");
const ShopifyOrder = require("../models/ShopifyOrder");
const router = express.Router();

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

    // NEW: system timestamps for incremental sync
    shopifyCreatedAt: o.created_at ? new Date(o.created_at) : null,
    shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,

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

    cancelled_at: o.cancelled_at ? new Date(o.cancelled_at) : null,
    cancel_reason: o.cancel_reason || null,
  };
}

/**
 * Internal helper to page through a given URL until done; upserts orders
 */
async function pageAndUpsertAll(url, headers) {
  let fetched = 0, created = 0, updated = 0;

  while (url) {
    const resp = await axios.get(url, { headers });
    const orders = resp.data?.orders || [];
    fetched += orders.length;

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

  return { fetched, created, updated };
}

/**
 * GET /api/orders/sync-all
 * (unchanged) — pulls the entire history from the very first order
 */
router.get("/sync-all", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }
    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    const url = `${base}/orders.json?status=any&limit=${limit}`;
    const headers = {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    };

    const stats = await pageAndUpsertAll(url, headers);
    res.json({ ok: true, mode: "full", ...stats });
  } catch (err) {
    console.error("sync-all error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync all orders", details: err?.message || err });
  }
});


router.get("/sync-incremental", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }

    // Determine starting watermark
    let sinceISO = req.query.since;
    if (!sinceISO) {
      const latest = await ShopifyOrder.findOne({}, { shopifyUpdatedAt: 1 })
        .sort({ shopifyUpdatedAt: -1 })
        .lean();
      const baseDate = latest?.shopifyUpdatedAt ? new Date(latest.shopifyUpdatedAt) : new Date("2000-01-01T00:00:00Z");
      // 5-minute safety buffer
      baseDate.setMinutes(baseDate.getMinutes() - 5);
      sinceISO = baseDate.toISOString();
    }

    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    // Filter by updated_at_min so we get both brand-new and modified orders
    // (Shopify cursor pagination still works with this filter.)
    let url = `${base}/orders.json?status=any&limit=${limit}&updated_at_min=${encodeURIComponent(sinceISO)}`;

    const headers = {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    };

    const stats = await pageAndUpsertAll(url, headers);
    res.json({ ok: true, mode: "incremental", since: sinceISO, ...stats });
  } catch (err) {
    console.error("sync-incremental error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync incrementally", details: err?.message || err });
  }
});

/**
 * (Optional) GET /api/orders/sync-range
 * Pull changes by UPDATED time within a date range.
 *   ?from=2025-09-01&to=2025-09-08
 */
router.get("/sync-range", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : null;
    const to   = req.query.to   ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
    if (!from || !to || isNaN(from) || isNaN(to)) {
      return res.status(400).json({ error: "Provide valid from/to (YYYY-MM-DD)" });
    }
    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    let url = `${base}/orders.json?status=any&limit=${limit}` +
              `&updated_at_min=${encodeURIComponent(from.toISOString())}` +
              `&updated_at_max=${encodeURIComponent(to.toISOString())}`;

    const headers = {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    };

    const stats = await pageAndUpsertAll(url, headers);
    res.json({ ok: true, mode: "range", from: from.toISOString(), to: to.toISOString(), ...stats });
  } catch (err) {
    console.error("sync-range error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync range", details: err?.message || err });
  }
});

/**
 * (Optional) GET /api/orders/refresh/:orderId
 * Force-refresh a single order by its numeric Shopify ID.
 */
router.get("/refresh/:orderId", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    const id = req.params.orderId;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }
    if (!id) return res.status(400).json({ error: "orderId required" });

    const url = `${shopifyBase(SHOPIFY_STORE_NAME)}/orders/${id}.json`;
    const headers = { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };
    const { data } = await axios.get(url, { headers });
    const doc = mapOrder(data.order);
    await ShopifyOrder.updateOne({ orderId: doc.orderId }, { $set: doc }, { upsert: true });
    res.json({ ok: true, orderId: doc.orderId });
  } catch (err) {
    console.error("refresh-one error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to refresh order", details: err?.message || err });
  }
});

/**
 * (unchanged) GET /api/orders
 * List orders with pagination & filters
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
