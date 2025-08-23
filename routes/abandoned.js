// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer");

const router = express.Router();

// GET /api/abandoned?query=&start=&end=&page=1&limit=50&assigned=assigned|unassigned
router.get("/", async (req, res) => {
  try {
    const { query = "", start = "", end = "", page = 1, limit = 50, assigned = "" } = req.query;

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
        { type: rx },
        { "items.title": rx },
        { "items.variantTitle": rx },
      ];
    }

    if (start || end) {
      q.eventAt = {};
      if (start) q.eventAt.$gte = new Date(start);
      if (end) q.eventAt.$lte = new Date(end);
    }

    if (assigned === "assigned") {
      q["assignedExpert._id"] = { $exists: true, $ne: null };
    } else if (assigned === "unassigned") {
      q.$or = q.$or || [];
      q.$or.push({ assignedExpert: { $exists: false } }, { "assignedExpert._id": { $exists: false } });
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

// POST /api/abandoned/:id/assign-expert
router.post("/:id/assign-expert", async (req, res) => {
  try {
    const { id } = req.params;
    const { expertId } = req.body;

    if (!expertId) return res.status(400).json({ error: "missing_expertId" });

    const ab = await AbandonedCheckout.findById(id);
    if (!ab) return res.status(404).json({ error: "not_found" });

    const emp = await Employee.findById(expertId).lean();
    if (!emp) return res.status(400).json({ error: "invalid_expert" });
    if (!ab.customer?.phone) return res.status(400).json({ error: "missing_phone" });

    // map lookingFor from first product title
    const firstTitle = Array.isArray(ab.items) && ab.items[0]?.title ? String(ab.items[0].title) : "";
    let lookingFor = "Others";
    if (/karela\s*jamun\s*fizz/i.test(firstTitle)) lookingFor = "Diabetes";
    else if (/liver\s*fix/i.test(firstTitle)) lookingFor = "Fatty Liver";

    // create Customer
    const customerDoc = new Customer({
      name: ab.customer?.name || "",
      phone: ab.customer?.phone || "",
      age: 0,
      location: "",
      lookingFor,
      assignedTo: emp.fullName,
      followUpDate: new Date(),
      leadSource: "Abandoned Cart",
      leadDate: ab.eventAt ? new Date(ab.eventAt) : new Date(),
    });
    await customerDoc.save();

    // persist assignment on AbandonedCheckout so it sticks on refresh
    const now = new Date();
    ab.assignedExpert = {
      _id: emp._id,
      fullName: emp.fullName,
      email: emp.email,
      role: emp.role,
    };
    ab.assignedAt = now;
    await ab.save();

    return res.json({
      ok: true,
      customerId: customerDoc._id,
      assignedExpert: ab.assignedExpert,
      assignedAt: now.toISOString(),
    });
  } catch (e) {
    console.error("assign-expert error:", e);
    res.status(500).json({ error: "assign_failed" });
  }
});

module.exports = router;
