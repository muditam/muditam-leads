// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Lead = require("../models/Lead");

const router = express.Router();

/* ------------------------- helpers ------------------------- */

function normalizePhone(p) {
  if (!p) return "";
  const digits = String(p).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function nameOnly(s) {
  // strip " (email)" patterns if present
  return String(s || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Find best employee for a given normalized phone (last10) using Customer/Lead.
 * Priority: Retention Agent > any other agent.
 * Returns an Employee doc or null.
 */
async function findBestEmployeeForLast10(last10) {
  if (!last10) return null;

  const suffixRx = new RegExp(`${escapeRx(last10)}$`);

  const [cust, lead] = await Promise.all([
    Customer.findOne({ phone: { $regex: suffixRx } }).sort({ createdAt: -1 }).lean(),
    Lead.findOne({ contactNumber: { $regex: suffixRx } }).sort({ _id: -1 }).lean(),
  ]);

  // Collect candidate names (strings)
  const candidates = [];
  if (cust?.assignedTo) candidates.push(nameOnly(cust.assignedTo));
  if (lead?.healthExpertAssigned) candidates.push(nameOnly(lead.healthExpertAssigned)); // retention
  if (lead?.agentAssigned) candidates.push(nameOnly(lead.agentAssigned));               // sales
  const uniqueNames = [...new Set(candidates.filter(Boolean))];
  if (uniqueNames.length === 0) return null;

  // Resolve names to employees
  const employees = await Employee.find({
    fullName: { $in: uniqueNames },
    status: "active",
  }).lean();

  if (!employees || employees.length === 0) return null;

  // Prefer Retention Agent
  const retention = employees.find((e) => e.role === "Retention Agent");
  if (retention) return retention;

  // Otherwise any match (e.g., Sales Agent)
  return employees[0] || null;
}

/**
 * For a list of AbandonedCheckout docs (unassigned), attempt to
 * auto-assign based on existing Customer/Lead using phone.
 * Mutates DB only; does not return modified docs.
 */
async function autoAssignBatch(docs) {
  const now = new Date();
  for (const d of docs) {
    const last10 = normalizePhone(d?.customer?.phone);
    if (!last10) continue;

    const emp = await findBestEmployeeForLast10(last10);
    if (!emp) continue;

    await AbandonedCheckout.updateOne(
      { _id: d._id, "assignedExpert._id": { $exists: false } },
      {
        $set: {
          assignedExpert: {
            _id: emp._id,
            fullName: emp.fullName,
            email: emp.email,
            role: emp.role,
          },
          assignedAt: now,
        },
      }
    );
  }
}

/* -------------------------- routes -------------------------- */

// GET /api/abandoned?query=&start=&end=&page=1&limit=50&assigned=assigned|unassigned
router.get("/", async (req, res) => {
  try {
    const { query = "", start = "", end = "", page = 1, limit = 50, assigned = "" } = req.query;

    const base = {};

    if (query) {
      const rx = new RegExp(escapeRx(query.trim()), "i");
      base.$or = [
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
      base.eventAt = {};
      if (start) base.eventAt.$gte = new Date(start);
      if (end) base.eventAt.$lte = new Date(end);
    }

    // Build the filter with assigned toggle
    const q = { ...base };
    if (assigned === "assigned") {
      q["assignedExpert._id"] = { $exists: true, $ne: null };
    } else if (assigned === "unassigned") {
      q.$and = (q.$and || []).concat([
        { $or: [{ assignedExpert: { $exists: false } }, { "assignedExpert._id": { $exists: false } }] },
      ]);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const skip = (pageNum - 1) * pageSize;

    // If user asked for Unassigned, first try auto-assign for THIS page's slice,
    // then re-run the query so freshly assigned rows disappear from unassigned.
    if (assigned === "unassigned") {
      const candidateSlice = await AbandonedCheckout.find(q)
        .sort({ eventAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .select("_id customer.phone")
        .lean();

      if (candidateSlice.length) {
        await autoAssignBatch(candidateSlice);
      }
    }

    // Final list after potential auto-assign
    const [items, total] = await Promise.all([
      AbandonedCheckout.find(q).sort({ eventAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      AbandonedCheckout.countDocuments(q),
    ]);

    res.json({ items, total, page: pageNum, limit: pageSize });
  } catch (e) {
    console.error("GET /api/abandoned error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/abandoned/:id/assign-expert
// If same phone exists in Customer/Lead, prefer Retention Agent and ONLY assign on AbandonedCheckout (no Customer insert).
// Else, create a Customer document and persist assignment.
router.post("/:id/assign-expert", async (req, res) => {
  try {
    const { id } = req.params;
    const { expertId } = req.body;

    const ab = await AbandonedCheckout.findById(id);
    if (!ab) return res.status(404).json({ error: "not_found" });

    const last10 = normalizePhone(ab?.customer?.phone);
    if (!last10) return res.status(400).json({ error: "missing_phone" });

    // 1) Check if we can auto-deduce expert from existing Customer/Lead (Retention priority)
    const preEmp = await findBestEmployeeForLast10(last10);
    if (preEmp) {
      const now = new Date();
      ab.assignedExpert = {
        _id: preEmp._id,
        fullName: preEmp.fullName,
        email: preEmp.email,
        role: preEmp.role,
      };
      ab.assignedAt = now;
      await ab.save();

      // Do NOT create a Customer doc in this path
      return res.json({
        ok: true,
        assignedExpert: ab.assignedExpert,
        assignedAt: now.toISOString(),
        usedExistingAssignment: true,
      });
    }

    // 2) No pre-existing expert found — fall back to the expert selected in UI
    if (!expertId) return res.status(400).json({ error: "missing_expertId" });

    const emp = await Employee.findById(expertId).lean();
    if (!emp) return res.status(400).json({ error: "invalid_expert" });

    // lookingFor mapping from first product title
    const firstTitle = Array.isArray(ab.items) && ab.items[0]?.title ? String(ab.items[0].title) : "";
    let lookingFor = "Others";
    if (/karela\s*jamun\s*fizz/i.test(firstTitle)) lookingFor = "Diabetes";
    else if (/liver\s*fix/i.test(firstTitle)) lookingFor = "Fatty Liver";

    // Create Customer doc (your requested behavior when no prior record exists)
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

    // Persist assignment on AbandonedCheckout so it sticks on refresh
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
      usedExistingAssignment: false,
    });
  } catch (e) {
    console.error("assign-expert error:", e);
    res.status(500).json({ error: "assign_failed" });
  }
});

module.exports = router;
