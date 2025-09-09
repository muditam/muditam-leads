// routes/cohart-dataApi.js
const express = require("express");
const router = express.Router();

// Import your existing Mongoose model (unchanged)
const ShopifyOrder = require("../models/ShopifyOrder");

// Utility — normalize phone to last 10 digits
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

// Quick health check
router.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /cohart-dataApi/records
 * Query params:
 *   - phone: string (required, raw phone; we normalize)
 *   - from:  ISO date (optional; inclusive lower bound)
 *   - to:    ISO date (optional; inclusive upper bound)
 *   - limit: number (default 500, max 2000)
 *   - skip:  number (default 0)
 *
 * Returns: array of ShopifyOrder docs sorted by orderDate ASC.
 */
router.get("/records", async (req, res) => {
  try {
    const { phone, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
    const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);

    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: "Missing or invalid ?phone" });

    const query = {
      $or: [
        { normalizedPhone: normalized },
        { contactNumber: { $regex: new RegExp(`${normalized}$`) } }, // fallback for legacy docs
      ],
    };

    if (from || to) {
      query.orderDate = {};
      if (from) query.orderDate.$gte = new Date(from);
      if (to) query.orderDate.$lte = new Date(to);
    }

    const projection =
      "orderId orderName customerName contactNumber normalizedPhone orderDate amount paymentGatewayNames modeOfPayment productsOrdered channelName customerAddress currency financial_status fulfillment_status";

    const docs = await ShopifyOrder.find(query, projection)
      .sort({ orderDate: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(docs);
  } catch (err) {
    console.error("GET /cohart-dataApi/records error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /cohart-dataApi/summary
 * Returns: { totalOrders, totalSpent, aov }
 */
router.get("/summary", async (req, res) => {
  try {
    const { phone, from, to } = req.query;
    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: "Missing or invalid ?phone" });

    const match = {
      $or: [
        { normalizedPhone: normalized },
        { contactNumber: { $regex: new RegExp(`${normalized}$`) } },
      ],
    };
    if (from || to) {
      match.orderDate = {};
      if (from) match.orderDate.$gte = new Date(from);
      if (to) match.orderDate.$lte = new Date(to);
    }

    const agg = await ShopifyOrder.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          totalSpent: 1,
          aov: {
            $cond: [
              { $gt: ["$totalOrders", 0] },
              { $round: [{ $divide: ["$totalSpent", "$totalOrders"] }, 2] },
              0,
            ],
          },
        },
      },
    ]);

    res.json(agg[0] || { totalOrders: 0, totalSpent: 0, aov: 0 });
  } catch (err) {
    console.error("GET /cohart-dataApi/summary error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
