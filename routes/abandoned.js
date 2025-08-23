// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer"); // <- your schema from the message

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
// Creates a Customer document from the abandoned checkout + selected expert.
router.post("/:id/assign-expert", async (req, res) => {
  try {
    const { id } = req.params;
    const { expertId } = req.body;

    if (!expertId) {
      return res.status(400).json({ error: "missing_expertId" });
    }

    const ab = await AbandonedCheckout.findById(id).lean();
    if (!ab) return res.status(404).json({ error: "not_found" });

    const emp = await Employee.findById(expertId).lean();
    if (!emp) return res.status(400).json({ error: "invalid_expert" });

    if (!ab.customer?.phone) {
      return res.status(400).json({ error: "missing_phone" });
    }

    // Map lookingFor from first product title
    const firstTitle = (Array.isArray(ab.items) && ab.items[0]?.title) ? String(ab.items[0].title) : "";
    let lookingFor = "Others";
    if (/karela\s*jamun\s*fizz/i.test(firstTitle)) lookingFor = "Diabetes";
    else if (/liver\s*fix/i.test(firstTitle)) lookingFor = "Fatty Liver";

    const customerDoc = new Customer({
      name: ab.customer?.name || "",
      phone: ab.customer?.phone || "",
      age: 0,
      location: "",
      lookingFor,
      assignedTo: emp.fullName,
      followUpDate: new Date(),                         // required by schema
      leadSource: "Abandoned Cart",
      leadDate: ab.eventAt ? new Date(ab.eventAt) : new Date(), // required by schema
      // leadStatus defaults to "New Lead"; subLeadStatus optional
    });

    await customerDoc.save();

    return res.json({ ok: true, customerId: customerDoc._id });
  } catch (e) {
    console.error("assign-expert error:", e);
    res.status(500).json({ error: "assign_failed" });
  }
});

module.exports = router;
