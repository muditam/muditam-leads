// routes/abandoned.js
const express = require("express");
const mongoose = require("mongoose");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Lead = require("../models/Lead");

const router = express.Router();

/* helpers (same as you had) */
function normalizePhoneTo10(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  return digits.slice(-10);
}
async function findEmployeeByNameLike(raw) {
  if (!raw) return null;
  const nameOnly = String(raw).trim().replace(/\s*\(.+\)\s*$/, "");
  if (!nameOnly) return null;
  const emp = await Employee.findOne({
    fullName: new RegExp(`^${nameOnly}$`, "i"),
    status: { $regex: /^active$/i },
  }).lean();
  return emp || null;
}
function choosePreferredEmployee(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c && c._id && !seen.has(String(c._id))) {
      seen.add(String(c._id));
      unique.push(c);
    }
  }
  const retention = unique.find((c) => (c.role || "").toLowerCase() === "retention agent");
  if (retention) return retention;
  const sales = unique.find((c) => (c.role || "").toLowerCase() === "sales agent");
  if (sales) return sales;
  return unique[0];
}
async function findExistingExpertForPhone(phone) {
  const n10 = normalizePhoneTo10(phone);
  if (!n10) return null;
  const [customers, leads] = await Promise.all([
    Customer.find({ phone: { $regex: `${n10}$` } }).lean(),
    Lead.find({ contactNumber: { $regex: `${n10}$` } }).lean(),
  ]);
  const candidateNames = [];
  for (const c of customers || []) if (c.assignedTo) candidateNames.push(c.assignedTo);
  for (const l of leads || []) {
    if (l.healthExpertAssigned) candidateNames.push(l.healthExpertAssigned);
    if (l.agentAssigned) candidateNames.push(l.agentAssigned);
  }
  if (candidateNames.length === 0) return null;
  const foundEmployees = [];
  for (const nm of candidateNames) {
    const emp = await findEmployeeByNameLike(nm);
    if (emp) foundEmployees.push(emp);
  }
  if (foundEmployees.length === 0) return null;
  return choosePreferredEmployee(foundEmployees);
}
async function autoAssignUnassignedMatching(filter, limit = 100) {
  const toScan = await AbandonedCheckout.find({
    ...filter,
    "assignedExpert._id": { $exists: false },
  })
    .sort({ eventAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  let updated = 0;
  for (const doc of toScan) {
    const expert = await findExistingExpertForPhone(doc?.customer?.phone);
    if (expert) {
      await AbandonedCheckout.updateOne(
        { _id: doc._id },
        {
          $set: {
            assignedExpert: {
              _id: expert._id,
              fullName: expert.fullName,
              email: expert.email,
              role: expert.role,
            },
            assignedAt: new Date(),
          },
        }
      );
      updated++;
    }
  }
  return updated;
}
function mapLookingForFromTitle(title = "") {
  const t = String(title).toLowerCase();
  if (/karela\s*jamun\s*fizz/.test(t)) return "Diabetes";
  if (/liver\s*fix/.test(t)) return "Fatty Liver";
  return "Others";
}

/* -------- GET /api/abandoned -------- */
router.get("/", async (req, res) => {
  try {
    const {
      query = "",
      start = "",
      end = "",
      page = 1,
      limit = 50,
      assigned = "",   // 'assigned' | 'unassigned'
      expertId = "",   // filter for one expert (agent view)
    } = req.query;

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

    // Convert expertId -> ObjectId if valid
    let expertObjectId = null;
    if (expertId && mongoose.Types.ObjectId.isValid(expertId)) {
      expertObjectId = new mongoose.Types.ObjectId(expertId);
    }

    if (assigned === "assigned") {
      if (expertObjectId) {
        q["assignedExpert._id"] = expertObjectId;
      } else {
        q["assignedExpert._id"] = { $exists: true };
      }
    } else if (assigned === "unassigned") {
      q["assignedExpert._id"] = { $exists: false };
    }

    if (assigned === "unassigned") {
      await autoAssignUnassignedMatching(q, 200);
      // (some may have moved to 'assigned' after auto-assign)
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

/* -------- POST /api/abandoned/:id/assign-expert -------- */
router.post("/:id/assign-expert", async (req, res) => {
  try {
    const { id } = req.params;
    const { expertId } = req.body;

    if (!expertId || !mongoose.Types.ObjectId.isValid(expertId)) {
      return res.status(400).json({ error: "missing_or_invalid_expertId" });
    }

    const ab = await AbandonedCheckout.findById(id).lean();
    if (!ab) return res.status(404).json({ error: "not_found" });

    const postedExpert = await Employee.findById(expertId).lean();
    if (!postedExpert) return res.status(400).json({ error: "invalid_expert" });

    const phone = ab?.customer?.phone;
    if (!phone) return res.status(400).json({ error: "missing_phone" });

    const existingExpert = await findExistingExpertForPhone(phone);

    if (existingExpert) {
      await AbandonedCheckout.updateOne(
        { _id: ab._id },
        {
          $set: {
            assignedExpert: {
              _id: existingExpert._id,
              fullName: existingExpert.fullName,
              email: existingExpert.email,
              role: existingExpert.role,
            },
            assignedAt: new Date(),
          },
        }
      );

      return res.json({
        ok: true,
        assignedAt: new Date().toISOString(),
        expert: {
          _id: existingExpert._id,
          fullName: existingExpert.fullName,
          email: existingExpert.email,
          role: existingExpert.role,
        },
        createdCustomer: false,
        usedExistingAssignment: true,
      });
    }

    const firstItemTitle = Array.isArray(ab.items) && ab.items.length ? ab.items[0].title : "";
    const lookingFor = mapLookingForFromTitle(firstItemTitle);

    const customerDoc = new Customer({
      name: ab.customer?.name || "",
      phone: phone,
      age: 0,
      location: "",
      lookingFor,
      assignedTo: postedExpert.fullName,
      followUpDate: new Date(),
      leadSource: "Abandoned Cart",
      leadDate: ab.eventAt ? new Date(ab.eventAt) : new Date(),
    });
    await customerDoc.save();

    await AbandonedCheckout.updateOne(
      { _id: ab._id },
      {
        $set: {
          assignedExpert: {
            _id: postedExpert._id,
            fullName: postedExpert.fullName,
            email: postedExpert.email,
            role: postedExpert.role,
          },
          assignedAt: new Date(),
        },
      }
    );

    return res.json({
      ok: true,
      assignedAt: new Date().toISOString(),
      expert: {
        _id: postedExpert._id,
        fullName: postedExpert.fullName,
        email: postedExpert.email,
        role: postedExpert.role,
      },
      createdCustomer: true,
      usedExistingAssignment: false,
      customerId: customerDoc._id,
    });
  } catch (e) {
    console.error("assign-expert error:", e);
    res.status(500).json({ error: "assign_failed" });
  }
});

module.exports = router;
