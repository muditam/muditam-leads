// routes/shipmentSync.js
const express = require("express");
const router = express.Router();

const ShopifyOrder = require("../models/ShopifyOrder"); 
const Order = require("../models/Order");            

// --- helpers ---
const normalize = (v) => (v == null ? "" : String(v).trim());
const withHash = (id) => (id?.startsWith("#") ? id : `#${id}`);
const withoutHash = (id) => (id?.startsWith("#") ? id.slice(1) : id);

router.post("/orders/sync-shipment-status", async (req, res) => {
  try {
    // ---- accept body or query params ----
    let { all, sinceHours, order_ids } = req.body || {};

    // Accept querystring too (useful from browser/tools)
    if (typeof all === "undefined" && typeof req.query.all !== "undefined") {
      all = req.query.all === "true" || req.query.all === "1" || req.query.all === true;
    }
    if (typeof sinceHours === "undefined" && typeof req.query.sinceHours !== "undefined") {
      sinceHours = Number(req.query.sinceHours);
    }
    if (!order_ids && typeof req.query.order_ids === "string") {
      order_ids = req.query.order_ids.split(",").map((s) => s.trim()).filter(Boolean);
    }

    // ---- default: do ALL if nothing provided ----
    if (!all && !sinceHours && (!Array.isArray(order_ids) || order_ids.length === 0)) {
      all = true;
    }

    // ---- build query for Order collection ----
    let orderQuery = {};
    if (all) {
      orderQuery = {}; // absolutely everything
    } else if (Array.isArray(order_ids) && order_ids.length > 0) {
      const ids = order_ids.map(normalize).filter(Boolean);
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: "'order_ids' contains no usable values." });
      }
      orderQuery = { order_id: { $in: ids } };
    } else if (sinceHours) {
      const hours = Number(sinceHours);
      if (Number.isNaN(hours) || hours <= 0) {
        return res.status(400).json({ ok: false, error: "'sinceHours' must be a positive number." });
      }
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      orderQuery = { last_updated_at: { $gte: since } };
    } else {
      return res.status(400).json({
        ok: false,
        error: "Provide one of: { all: true } OR 'order_ids' (array) OR 'sinceHours' (number).",
      });
    }

    // ---- OPTIONAL speed-up: preload all orderName values from ShopifyOrder ----
    // Lets us quickly skip Orders that can't possibly match and keeps writes lean.
    const shopifyNameSet = new Set(
      (await ShopifyOrder.find({}, { orderName: 1 }).lean()).map((d) => normalize(d.orderName))
    );

    // ---- stream ALL matching Orders (no .limit()) ----
    const cursor = Order.find(orderQuery)
      .sort({ last_updated_at: -1 })
      .select({ order_id: 1, shipment_status: 1 })
      .cursor();

    const BULK_CHUNK_SIZE = 1000; // batch size for writes (NOT a cap)
    let bulkOps = [];
    let updated = 0;

    let scanned = 0;
    let matched = 0;
    let skippedNoId = 0;
    let skippedNoMatch = 0;

    // If response with full details on 50k+ becomes too large, you can turn this off.
    const details = [];

    for await (const ord of cursor) {
      scanned += 1;

      const rawId = normalize(ord.order_id);
      const shipStatus = normalize(ord.shipment_status);

      if (!rawId) {
        skippedNoId += 1;
        details.push({ order_id: ord.order_id, skipped: true, reason: "Empty order_id" });
        continue;
      }

      const candidateA = withHash(rawId);    // "#MA83477"
      const candidateB = withoutHash(rawId); // "MA83477"

      // Skip quickly if no Shopify match exists at all
      if (!shopifyNameSet.has(candidateA) && !shopifyNameSet.has(candidateB)) {
        skippedNoMatch += 1;
        details.push({ order_id: rawId, skipped: true, reason: "No matching Shopify orderName" });
        continue;
      }

      matched += 1;

      bulkOps.push({
        updateOne: {
          filter: { $or: [{ orderName: candidateA }, { orderName: candidateB }] },
          update: { $set: { shipment_status: shipStatus, shopifyUpdatedAt: new Date() } },
          upsert: false,
        },
      });

      // flush in chunks
      if (bulkOps.length >= BULK_CHUNK_SIZE) {
        const result = await ShopifyOrder.bulkWrite(bulkOps, { ordered: false });
        updated += result.modifiedCount ?? result.nModified ?? 0;
        bulkOps = [];
      }
    }

    // flush remaining
    if (bulkOps.length > 0) {
      const result = await ShopifyOrder.bulkWrite(bulkOps, { ordered: false });
      updated += result.modifiedCount ?? result.nModified ?? 0;
    }

    return res.json({
      ok: true,
      scannedOrders: scanned,
      matchedOrders: matched,
      updated,
      skippedNoId, 
      skippedNoMatch, 
      details,   
    });
  } catch (err) {
    console.error("sync-shipment-status error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

module.exports = router;
