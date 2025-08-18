// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");

const router = express.Router();

// GET /api/abandoned?query=&start=&end=&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const { query = "", start = "", end = "", page = 1, limit = 50 } = req.query;

    const q = {};

    if (query) {
      const rx = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [
        { "customer.name": rx },
        { "customer.email": rx },
        { "customer.phone": rx },
        { eventId: rx },
        { checkoutId: rx },
        { orderId: rx },
      ];
    }

    if (start || end) {
      q.eventAt = {};
      if (start) q.eventAt.$gte = new Date(start);
      if (end) q.eventAt.$lte = new Date(end);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const skip = (pageNum - 1) * pageSize;

    const [items, total] = await Promise.all([
      AbandonedCheckout.find(q).sort({ eventAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      AbandonedCheckout.countDocuments(q),
    ]);

    res.json({ items, total, page: pageNum, limit: pageSize });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/abandoned/:id/notify
router.post("/:id/notify", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await AbandonedCheckout.findById(id);
    if (!doc) return res.status(404).json({ error: "not_found" });

    // TODO: invoke your WhatsApp/SMS/Email service here

    await AbandonedCheckout.findByIdAndUpdate(id, {
      $set: { notified: true, notifiedAt: new Date(), notifyChannel: "manual" },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "notify_failed" });
  }
});

module.exports = router;
