// routes/abandoned.js
const express = require("express");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Lead = require("../models/Lead");

const router = express.Router();

/* ------------------------- helpers ------------------------- */

function normalizePhoneTo10(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  // Keep the last 10 digits (typical Indian MSISDN)
  return digits.slice(-10);
}

// attempt to match an Employee by a raw name field that may contain "Name (email)"
async function findEmployeeByNameLike(raw) {
  if (!raw) return null;
  const nameOnly = String(raw).trim().replace(/\s*\(.+\)\s*$/, ""); // remove " (email)" if present
  if (!nameOnly) return null;
  const emp = await Employee.findOne({
    fullName: new RegExp(`^${nameOnly}$`, "i"),
    status: { $regex: /^active$/i },
  }).lean();
  return emp || null;
}

// choose preferred employee (Retention Agent wins; else Sales Agent; else first)
function choosePreferredEmployee(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  // unique by _id
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c && c._id && !seen.has(String(c._id))) {
      seen.add(String(c._id));
      unique.push(c);
    }
  }
  if (unique.length === 0) return null;
  const retention = unique.find((c) => c.role === "Retention Agent");
  if (retention) return retention;
  const sales = unique.find((c) => c.role === "Sales Agent");
  if (sales) return sales;
  return unique[0];
}

// Given a phone, look into Customer/Lead and try to discover an already assigned expert.
// Returns an Employee doc (lean) or null.
async function findExistingExpertForPhone(phone) {
  const n10 = normalizePhoneTo10(phone);
  if (!n10) return null;

  // find any customers/leads whose phone/contactNumber ends with these 10 digits
  const [customers, leads] = await Promise.all([
    Customer.find({ phone: { $regex: `${n10}$` } }).lean(),
    Lead.find({ contactNumber: { $regex: `${n10}$` } }).lean(),
  ]);

  const candidateNames = [];
  for (const c of customers || []) {
    if (c.assignedTo) candidateNames.push(c.assignedTo);
  }
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

// Auto-assign a batch of unassigned docs (matching a given filter) if an existing expert is found.
// Returns number of docs updated.
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
    const phone = doc?.customer?.phone;
    const expert = await findExistingExpertForPhone(phone);
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

// map product title to lookingFor
function mapLookingForFromTitle(title = "") {
  const t = String(title).toLowerCase();
  if (/karela\s*jamun\s*fizz/.test(t)) return "Diabetes";
  if (/liver\s*fix/.test(t)) return "Fatty Liver";
  return "Others";
}

/* ------------------------- GET list ------------------------- */
/**
 * GET /api/abandoned
 * Query:
 *  - query: text search
 *  - start, end: ISO datetimes
 *  - page, limit
 *  - assigned: "assigned" | "unassigned" | (omit for all)
 *  - expertId: filter assigned expert (used for agent's own view)
 */
router.get("/", async (req, res) => {
  try {
    const {
      query = "",
      start = "",
      end = "",
      page = 1,
      limit = 50,
      assigned = "",          // 'assigned' | 'unassigned'
      expertId = "",          // show only this expert's leads (used by agents)
    } = req.query;

    const q = {};

    // text search
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

    // date filter
    if (start || end) {
      q.eventAt = {};
      if (start) q.eventAt.$gte = new Date(start);
      if (end) q.eventAt.$lte = new Date(end);
    }

    // assigned / unassigned filter
    if (assigned === "assigned") {
      q["assignedExpert._id"] = { $exists: true };
      if (expertId) {
        q["assignedExpert._id"] = { $exists: true, $eq: expertId };
      }
    } else if (assigned === "unassigned") {
      q["assignedExpert._id"] = { $exists: false };
    }

    // If user is browsing Unassigned, proactively auto-assign any that already
    // exist in Customer/Lead (by phone) to keep views consistent.
    if (assigned === "unassigned") {
      const updated = await autoAssignUnassignedMatching(q, 200);
      if (updated > 0) {
        // re-apply filter since some moved to 'assigned'
        // Nothing else to do; we just continue to fetch the page now.
      }
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

/* ------------------------- Assign expert ------------------------- */
/**
 * POST /api/abandoned/:id/assign-expert
 * Body: { expertId }
 *
 * Behavior:
 *  - normalize phone, check Customer/Lead for existing records
 *  - if an existing expert is found:
 *      - prefer Retention Agent when multiple
 *      - set AbandonedCheckout.assignedExpert to that expert
 *      - DO NOT create a new Customer
 *  - else (no existing record):
 *      - set AbandonedCheckout.assignedExpert to provided expertId
 *      - create a new Customer using mapping rules
 */
router.post("/:id/assign-expert", async (req, res) => {
  try {
    const { id } = req.params;
    const { expertId } = req.body;

    if (!expertId) {
      return res.status(400).json({ error: "missing_expertId" });
    }

    const ab = await AbandonedCheckout.findById(id).lean();
    if (!ab) return res.status(404).json({ error: "not_found" });

    const postedExpert = await Employee.findById(expertId).lean();
    if (!postedExpert) return res.status(400).json({ error: "invalid_expert" });

    const phone = ab?.customer?.phone;
    if (!phone) return res.status(400).json({ error: "missing_phone" });

    // Look for existing expert via Customer/Lead (by phone)
    const existingExpert = await findExistingExpertForPhone(phone);

    let finalExpert = postedExpert; // default to posted expert
    let createdCustomer = false;

    if (existingExpert) {
      // Prefer existing (and its retention priority is already handled)
      finalExpert = existingExpert;

      // If already in either collection, do NOT create a new Customer
      // (the doc will now show directly under Assigned)
      await AbandonedCheckout.updateOne(
        { _id: ab._id },
        {
          $set: {
            assignedExpert: {
              _id: finalExpert._id,
              fullName: finalExpert.fullName,
              email: finalExpert.email,
              role: finalExpert.role,
            },
            assignedAt: new Date(),
          },
        }
      );

      return res.json({
        ok: true,
        assignedAt: new Date().toISOString(),
        expert: {
          _id: finalExpert._id,
          fullName: finalExpert.fullName,
          email: finalExpert.email,
          role: finalExpert.role,
        },
        createdCustomer: false,
        usedExistingAssignment: true,
      });
    }

    // No existing records → assign to posted expert & create a new Customer
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
      // leadStatus default "New Lead"
    });
    await customerDoc.save();
    createdCustomer = true;

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
      createdCustomer,
      usedExistingAssignment: false,
      customerId: customerDoc._id,
    });
  } catch (e) {
    console.error("assign-expert error:", e);
    res.status(500).json({ error: "assign_failed" });
  }
});

module.exports = router;
