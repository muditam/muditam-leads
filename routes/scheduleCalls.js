// routes/scheduleCalls.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const ScheduleCall = require("../models/ScheduleCall");
const ShopifyOrder = require("../models/ShopifyOrder"); // ⬅️ ADDED

// ---- Helpers ----
function parseTimeHM(hm = "10:30") {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  return { h: isNaN(h) ? 0 : h, m: isNaN(m) ? 0 : m };
}

function startOfDayLocal(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

function endOfDayLocal(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`);
}

function addMinutes(date, min) {
  return new Date(date.getTime() + min * 60 * 1000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

router.post("/", async (req, res) => {
  try {
    const {
      doctorCallNeeded = true,
      assignedExpert,
      scheduleCallAt,
      scheduleDurationMin,
      scheduleCallNotes = "",
      orderId,
      customerId,
      createdBy,
    } = req.body || {};

    if (!assignedExpert) return res.status(400).json({ error: "assignedExpert is required" });
    if (!scheduleCallAt) return res.status(400).json({ error: "scheduleCallAt is required" });
    if (!scheduleDurationMin) return res.status(400).json({ error: "scheduleDurationMin is required" });

    const start = new Date(scheduleCallAt);
    if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid scheduleCallAt" });
    const end = addMinutes(start, Number(scheduleDurationMin));

    // Find conflicting bookings for the same expert in the window
    const conflicts = await ScheduleCall.find({
      assignedExpert,
      status: { $in: ["SCHEDULED", "RESCHEDULED"] },
      // quick prefilter window: any booking touching this interval
      scheduleCallAt: { $lt: end },
    })
      .limit(50)
      .lean();

    const hasOverlap = conflicts.some((c) => {
      const cStart = new Date(c.scheduleCallAt);
      const cEnd = addMinutes(cStart, Number(c.scheduleDurationMin || 0));
      return overlaps(start, end, cStart, cEnd);
    });

    if (hasOverlap) {
      return res.status(409).json({ error: "This slot overlaps with an existing booking for the expert." });
    }

    const doc = await ScheduleCall.create({
      doctorCallNeeded: !!doctorCallNeeded,
      assignedExpert,
      scheduleCallAt: start,
      scheduleDurationMin,
      scheduleCallNotes,
      orderId: orderId && mongoose.isValidObjectId(orderId) ? orderId : undefined,
      customerId: customerId && mongoose.isValidObjectId(customerId) ? customerId : undefined,
      createdBy,
    });

    return res.json({ ok: true, schedule: doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Expert already has a booking starting at this minute." });
    }
    console.error("POST /api/schedule-calls error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/slots", async (req, res) => {
  try {
    const { date, expertId, businessStart = "10:30", businessEnd = "18:30" } = req.query || {};
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) is required" });

    const dayStart = startOfDayLocal(date);
    const dayEnd = endOfDayLocal(date);

    const filter = {
      status: { $in: ["SCHEDULED", "RESCHEDULED"] },
      scheduleCallAt: { $gte: dayStart, $lte: dayEnd },
    };
    if (expertId) filter.assignedExpert = expertId;

    const bookings = await ScheduleCall.find(filter)
      .select("scheduleCallAt assignedExpert scheduleDurationMin")
      .lean();

    // Optionally filter to business window only
    const { h: sH, m: sM } = parseTimeHM(businessStart);
    const { h: eH, m: eM } = parseTimeHM(businessEnd);
    const winStart = new Date(dayStart);
    winStart.setHours(sH, sM, 0, 0);
    const winEnd = new Date(dayStart);
    winEnd.setHours(eH, eM, 0, 0);

    const bookedSlots = bookings
      .filter((b) => {
        const st = new Date(b.scheduleCallAt);
        return st >= winStart && st < winEnd;
      })
      .map((b) => new Date(b.scheduleCallAt).toISOString());

    return res.json({ bookedSlots });
  } catch (err) {
    console.error("GET /api/schedule-calls/slots error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/", async (req, res) => {
  try {
    const { from, to, expertId, status, limit = 100, page = 1 } = req.query || {};
    const q = {};
    if (expertId) q.assignedExpert = expertId;
    if (status) q.status = status;
    if (from || to) {
      q.scheduleCallAt = {};
      if (from) q.scheduleCallAt.$gte = new Date(from);
      if (to) q.scheduleCallAt.$lte = new Date(to);
    }

    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;

    const [items, total] = await Promise.all([
      ScheduleCall.find(q).sort({ scheduleCallAt: 1 }).skip(skip).limit(lim).lean(),
      ScheduleCall.countDocuments(q),
    ]);

    // 🔹 Enrich with order details so frontend can render Order/Customer cells
    const orderIds = items
      .map((it) => it.orderId)
      .filter((id) => id && mongoose.isValidObjectId(id));

    let orderMap = {};
    if (orderIds.length) {
      const orders = await ShopifyOrder.find(
        { _id: { $in: orderIds } },
        {
          orderName: 1,
          productsOrdered: 1,
          customerName: 1,
          contactNumber: 1,
          normalizedPhone: 1,
        }
      ).lean();

      orderMap = orders.reduce((acc, o) => {
        acc[String(o._id)] = o;
        return acc;
      }, {});
    }

    const enrichedItems = items.map((it) => ({
      ...it,
      order: it.orderId ? orderMap[String(it.orderId)] || null : null,
    }));

    return res.json({ items: enrichedItems, total, page: Number(page || 1), limit: lim });
  } catch (err) {
    console.error("GET /api/schedule-calls error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      assignedExpert,
      scheduleCallAt,
      scheduleDurationMin,
      scheduleCallNotes,
      updatedBy,
    } = req.body || {};

    const update = {};
    if (typeof status === "string") update.status = status;
    if (typeof scheduleCallNotes === "string") update.scheduleCallNotes = scheduleCallNotes;
    if (typeof assignedExpert === "string") update.assignedExpert = assignedExpert;
    if (typeof scheduleDurationMin === "number") update.scheduleDurationMin = scheduleDurationMin;
    if (typeof scheduleCallAt === "string" || scheduleCallAt instanceof Date) update.scheduleCallAt = new Date(scheduleCallAt);
    if (updatedBy) update.updatedBy = updatedBy;

    if (
      (update.assignedExpert || update.scheduleCallAt || update.scheduleDurationMin) &&
      (!update.status || ["SCHEDULED", "RESCHEDULED"].includes(update.status))
    ) {
      const doc = await ScheduleCall.findById(id).lean();
      if (!doc) return res.status(404).json({ error: "Schedule not found" });

      const assigned = update.assignedExpert || doc.assignedExpert;
      const start = update.scheduleCallAt ? new Date(update.scheduleCallAt) : new Date(doc.scheduleCallAt);
      const duration =
        typeof update.scheduleDurationMin === "number" ? update.scheduleDurationMin : doc.scheduleDurationMin || 0;
      const end = new Date(start.getTime() + duration * 60000);

      const conflicts = await ScheduleCall.find({
        _id: { $ne: id },
        assignedExpert: assigned,
        status: { $in: ["SCHEDULED", "RESCHEDULED"] },
        scheduleCallAt: { $lt: end },
      })
        .limit(50)
        .lean();

      const overlaps = conflicts.some((c) => {
        const cStart = new Date(c.scheduleCallAt);
        const cEnd = new Date(cStart.getTime() + (c.scheduleDurationMin || 0) * 60000);
        return start < cEnd && cStart < end;
      });

      if (overlaps) {
        return res.status(409).json({ error: "This slot overlaps with an existing booking for the expert." });
      }
    }

    const updated = await ScheduleCall.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!updated) return res.status(404).json({ error: "Schedule not found" });

    return res.json({ ok: true, schedule: updated });
  } catch (err) {
    console.error("PUT /api/schedule-calls/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
