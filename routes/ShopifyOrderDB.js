// routes/orders.js
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const ShopifyOrder = require("../models/ShopifyOrder");
const router = express.Router();

function shopifyBase(store) {
  return `https://${store}.myshopify.com/admin/api/2024-04`;
}

// --- Utils ---
function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  return linkHeader.split(",").reduce((acc, part) => {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    const url = urlPart?.replace(/^<|>$/g, "");
    const rel = /rel="([^"]+)"/.exec(relPart || "")?.[1];
    if (url && rel) acc[rel] = url;
    return acc;
  }, {});
}

// Normalize to strict last-10-digits
function normalizePhone(v) {
  if (!v) return "";
  const d = String(v).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

function preferAddress(o) {
  const a = o.shipping_address || o.customer?.default_address || null;
  if (!a) return null;
  return {
    name: a.name || [a.first_name, a.last_name].filter(Boolean).join(" ").trim(),
    phone: normalizePhone(a.phone || ""), // normalized here
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

function stripOrderNameHash(name) {
  return String(name || "").replace(/^#+\s*/, ""); // remove all leading #'s and any space
}

function mapOrder(o) {
  const products = (o.line_items || []).map((li) => ({
    title: li.title,
    quantity: li.quantity,
    sku: li.sku || "",
    variant_id: li.variant_id,
    price: Number(li.price || 0),
  }));

  const paymentGatewayNames = Array.isArray(o.payment_gateway_names)
    ? o.payment_gateway_names
    : [];

  const rawContact = getContact(o);
  const ten = normalizePhone(rawContact); // normalized once
  const addr = preferAddress(o); // already normalized

  return {
    orderId: o.id,
    orderName: stripOrderNameHash(o.name),
    customerName:
      o.shipping_address?.name ||
      [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ").trim() ||
      o.customer?.default_address?.name ||
      "",

    // Store ONLY 10-digit phone
    contactNumber: ten,
    normalizedPhone: ten,

    orderDate: o.created_at ? new Date(o.created_at) : null,

    // Watermarks for sync
    shopifyCreatedAt: o.created_at ? new Date(o.created_at) : null,
    shopifyUpdatedAt: o.updated_at ? new Date(o.updated_at) : null,

    amount: Number(o.total_price || 0),
    paymentGatewayNames,
    modeOfPayment:
      paymentGatewayNames[0] || (o.gateway ? String(o.gateway) : paymentGatewayNames.join(", ")),
    productsOrdered: products,
    channelName: o.source_name || "",
    customerAddress: addr,
    currency: o.currency || "",
    financial_status: o.financial_status || "",
    fulfillment_status: o.fulfillment_status || "",

    cancelled_at: o.cancelled_at ? new Date(o.cancelled_at) : null,
    cancel_reason: o.cancel_reason || null,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPageWithRetry(url, headers, attempt = 0) {
  try {
    return await axios.get(url, { headers });
  } catch (err) {
    if (err.response?.status === 429) {
      const retryAfter = parseInt(err.response.headers["retry-after"] || "2", 10);
      const backoff = Math.min(30000, (retryAfter || 2) * 1000 * Math.max(1, attempt + 1));
      console.warn(`[Shopify] 429 — backing off for ${backoff}ms`);
      await wait(backoff);
      return fetchPageWithRetry(url, headers, attempt + 1);
    }
    throw err;
  }
}

/**
 * Page through a given URL until done; upserts orders.
 * Returns stats and last cursor info.
 */
async function pageAndUpsertAll(url, headers) {
  let fetched = 0, created = 0, updated = 0;

  while (url) {
    const resp = await fetchPageWithRetry(url, headers);
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

function authHeaders() {
  const { SHOPIFY_ACCESS_TOKEN } = process.env;
  return {
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    "Content-Type": "application/json",
    "User-Agent": "Muditam-OrdersSync/1.0",
  };
}

// -------------------- ROUTES --------------------

/**
 * GET /api/orders/sync-all
 * Pulls the entire history from the very first order (unchanged).
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
    const stats = await pageAndUpsertAll(url, authHeaders());
    res.json({ ok: true, mode: "full", ...stats });
  } catch (err) {
    console.error("sync-all error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync all orders", details: err?.message || err });
  }
});

/**
 * GET /api/orders/sync-new
 * Fetches ONLY orders newly CREATED after your latest stored shopifyCreatedAt.
 * Optional override: ?sinceCreated=ISO
 */
router.get("/sync-new", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }

    // Determine starting watermark by CREATED time
    let sinceISO = req.query.sinceCreated;
    if (!sinceISO) {
      const latest = await ShopifyOrder.findOne({}, { shopifyCreatedAt: 1 })
        .sort({ shopifyCreatedAt: -1 })
        .lean();
      const baseDate = latest?.shopifyCreatedAt
        ? new Date(latest.shopifyCreatedAt)
        : new Date("2000-01-01T00:00:00Z");
      baseDate.setMinutes(baseDate.getMinutes() - 2); // small safety buffer
      sinceISO = baseDate.toISOString();
    }

    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    let url = `${base}/orders.json?status=any&limit=${limit}&created_at_min=${encodeURIComponent(
      sinceISO
    )}`;

    const stats = await pageAndUpsertAll(url, authHeaders());
    res.json({ ok: true, mode: "new-created", sinceCreated: sinceISO, ...stats });
  } catch (err) {
    console.error("sync-new error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync newly created orders", details: err?.message || err });
  }
});

/**
 * GET /api/orders/sync-incremental
 * Uses UPDATED watermark to catch edits & late changes.
 */
router.get("/sync-incremental", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }

    // Determine starting watermark by UPDATED time
    let sinceISO = req.query.since;
    if (!sinceISO) {
      const latest = await ShopifyOrder.findOne({}, { shopifyUpdatedAt: 1 })
        .sort({ shopifyUpdatedAt: -1 })
        .lean();
      const baseDate = latest?.shopifyUpdatedAt
        ? new Date(latest.shopifyUpdatedAt)
        : new Date("2000-01-01T00:00:00Z");
      baseDate.setMinutes(baseDate.getMinutes() - 5); // 5-min safety buffer
      sinceISO = baseDate.toISOString();
    }

    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);
    let url = `${base}/orders.json?status=any&limit=${limit}&updated_at_min=${encodeURIComponent(
      sinceISO
    )}`;

    const stats = await pageAndUpsertAll(url, authHeaders());
    res.json({ ok: true, mode: "incremental-updated", since: sinceISO, ...stats });
  } catch (err) {
    console.error("sync-incremental error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync incrementally", details: err?.message || err });
  }
});

/**
 * GET /api/orders/sync-range?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get("/sync-range", async (req, res) => {
  try {
    const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
    if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
      return res.status(400).json({ error: "Missing Shopify env vars" });
    }
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : null;
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
    if (!from || !to || isNaN(from) || isNaN(to)) {
      return res.status(400).json({ error: "Provide valid from/to (YYYY-MM-DD)" });
    }
    const base = shopifyBase(SHOPIFY_STORE_NAME);
    const limit = Math.min(parseInt(req.query.limit || "250", 10) || 250, 250);

    let url =
      `${base}/orders.json?status=any&limit=${limit}` +
      `&updated_at_min=${encodeURIComponent(from.toISOString())}` +
      `&updated_at_max=${encodeURIComponent(to.toISOString())}`;

    const stats = await pageAndUpsertAll(url, authHeaders());
    res.json({ ok: true, mode: "range-updated", from: from.toISOString(), to: to.toISOString(), ...stats });
  } catch (err) {
    console.error("sync-range error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to sync range", details: err?.message || err });
  }
});

/**
 * GET /api/orders/refresh/:orderId
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
    const { data } = await fetchPageWithRetry(url, authHeaders());
    const doc = mapOrder(data.order);
    await ShopifyOrder.updateOne({ orderId: doc.orderId }, { $set: doc }, { upsert: true });
    res.json({ ok: true, orderId: doc.orderId });
  } catch (err) {
    console.error("refresh-one error:", err?.response?.data || err);
    res.status(500).json({ error: "Failed to refresh order", details: err?.message || err });
  }
});

/**
 * GET /api/orders
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

/**
 * POST /api/orders/normalize-phones
 * One-time (or repeatable) cleanup for historical rows
 */
router.post("/normalize-phones", async (req, res) => {
  try {
    const cursor = ShopifyOrder.find({}, { contactNumber: 1, customerAddress: 1, normalizedPhone: 1 }).cursor();
    let scanned = 0, changed = 0, bulk = [];

    for await (const doc of cursor) {
      scanned++;
      const currentCN = doc.contactNumber || "";
      const currentAddrPhone = doc.customerAddress?.phone || "";
      const newCN = normalizePhone(currentCN);
      const newAddrPhone = normalizePhone(currentAddrPhone);
      const bestNorm = newCN || newAddrPhone || "";

      const needsUpdate =
        newCN !== currentCN ||
        newAddrPhone !== currentAddrPhone ||
        (bestNorm !== (doc.normalizedPhone || ""));

      if (needsUpdate) {
        changed++;
        const $set = {};
        if (newCN !== currentCN) $set.contactNumber = newCN;
        if (newAddrPhone !== currentAddrPhone) $set["customerAddress.phone"] = newAddrPhone;
        if (bestNorm !== (doc.normalizedPhone || "")) $set.normalizedPhone = bestNorm;

        bulk.push({ updateOne: { filter: { _id: doc._id }, update: { $set } } });
        if (bulk.length >= 1000) {
          await ShopifyOrder.bulkWrite(bulk, { ordered: false });
          bulk = [];
        }
      }
    }

    if (bulk.length) await ShopifyOrder.bulkWrite(bulk, { ordered: false });

    res.json({ ok: true, scanned, changed });
  } catch (err) {
    console.error("normalize-phones error:", err);
    res.status(500).json({ ok: false, error: "Failed to normalize phones", details: err?.message || err });
  }
});

// -------------------- NIGHTLY CRON (11:00 PM IST) --------------------
// To avoid double scheduling in hot-reload environments:
if (!global.__SHOPIFY_SYNC_NEW_CRON__) {
  global.__SHOPIFY_SYNC_NEW_CRON__ = true;
  cron.schedule(
    "0 23 * * *", // 23:00 every day
    async () => {
      try {
        const { SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME } = process.env;
        if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_NAME) {
          console.warn("[Cron] Skipping sync-new — missing Shopify env vars");
          return;
        }
        console.log("[Cron] Running nightly Shopify new-orders sync (created_at) @ 23:00 IST");

        // compute created watermark exactly like /sync-new
        const latest = await ShopifyOrder.findOne({}, { shopifyCreatedAt: 1 })
          .sort({ shopifyCreatedAt: -1 })
          .lean();
        const baseDate = latest?.shopifyCreatedAt
          ? new Date(latest.shopifyCreatedAt)
          : new Date("2000-01-01T00:00:00Z");
        baseDate.setMinutes(baseDate.getMinutes() - 2);
        const sinceISO = baseDate.toISOString();

        const base = shopifyBase(process.env.SHOPIFY_STORE_NAME);
        const limit = 250;
        let url = `${base}/orders.json?status=any&limit=${limit}&created_at_min=${encodeURIComponent(sinceISO)}`;

        const stats = await pageAndUpsertAll(url, authHeaders());
        console.log("[Cron] Shopify new-orders sync done:", { sinceCreated: sinceISO, ...stats });
      } catch (err) {
        console.error("[Cron] Shopify new-orders sync FAILED:", err?.response?.data || err);
      }
    },
    { timezone: "Asia/Kolkata" } 
  );
}

module.exports = router; 
