// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");

const router = express.Router();

function parseISOorNull(s) {
  try {
    return s ? new Date(s) : null;
  } catch {
    return null;
  }
}

// Convert date-only IST to UTC window
function istRangeToUTC(startLocal, endLocal) {
  const out = {};
  // IST offset = +05:30 => subtract 330 minutes to get UTC
  const IST_OFFSET_MIN = 330;

  if (startLocal) {
    const d = new Date(`${startLocal}T00:00:00.000Z`);
    d.setMinutes(d.getMinutes() - IST_OFFSET_MIN);
    out.$gte = d;
  }
  if (endLocal) {
    const d = new Date(`${endLocal}T23:59:59.999Z`);
    d.setMinutes(d.getMinutes() - IST_OFFSET_MIN);
    out.$lte = d;
  }
  return out;
}

// GET /api/abandoned?query=&start=&end=&startLocal=&endLocal=&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const {
      query = "",
      start = "",
      end = "",
      startLocal = "",
      endLocal = "",
      page = 1,
      limit = 50,
    } = req.query;

    const q = {};

    // Date filter: prefer IST date-only if provided
    if (startLocal || endLocal) {
      const r = istRangeToUTC(startLocal, endLocal);
      if (r.$gte || r.$lte) q.eventAt = r;
    } else if (start || end) {
      q.eventAt = {};
      if (start) q.eventAt.$gte = parseISOorNull(start);
      if (end) q.eventAt.$lte = parseISOorNull(end);
      if (!q.eventAt.$gte) delete q.eventAt.$gte;
      if (!q.eventAt.$lte) delete q.eventAt.$lte;
      if (Object.keys(q.eventAt).length === 0) delete q.eventAt;
    }

    if (query) {
      const esc = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      q.$or = [
        { requestId: rx },
        { cId: rx },
        { token: rx },
        { eventId: rx },
        { checkoutId: rx },
        { orderId: rx },
        { abcUrl: rx },
        { type: rx },
        { currency: rx },
        { "customer.name": rx },
        { "customer.email": rx },
        { "customer.phone": rx },
        { "items.title": rx },
        { "items.variantTitle": rx },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const skip = (pageNum - 1) * pageSize;

    const [docs, total] = await Promise.all([
      AbandonedCheckout.find(q)
        .sort({ eventAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      AbandonedCheckout.countDocuments(q),
    ]);

    // Alias GoKwik ids so existing UI fields render correctly
    const items = docs.map((d) => ({
      ...d,
      eventId: d.eventId || d.requestId || d.cId || d.token || null,
      checkoutId: d.checkoutId || d.token || null,
    }));

    res.json({ items, total, page: pageNum, limit: pageSize });
  } catch (e) {
    console.error("GET /api/abandoned error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/abandoned/:id/notify
router.post("/:id/notify", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await AbandonedCheckout.findById(id);
    if (!doc) return res.status(404).json({ error: "not_found" });

    // TODO: integrate WhatsApp/SMS/Email here
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



