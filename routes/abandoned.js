const express = require("express");
const mongoose = require("mongoose");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Employee = require("../models/Employee");
const Customer = require("../models/Customer");
const Lead = require("../models/Lead");
const ConsultationDetails = require("../models/ConsultationDetails");  

const router = express.Router();

/* -------------------- helpers -------------------- */
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
function escapeRegex(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------- Money & cart helpers (NEW) ---------- */
function formatMoneyMinor(minor, currency = "INR") {
  if (typeof minor !== "number") return "";
  const n = minor / 100;
  return `${currency} ${n.toFixed(2)}`;
}
function productCodeFromTitle(title = "") {
  const t = String(title).trim();
  const tl = t.toLowerCase();

  // Preferred explicit mappings
  if (/karela\s*jamun\s*fizz/i.test(tl)) return "KJF";
  if (/liver\s*defend\s*pro/i.test(tl)) return "LDP";
  if (/liver\s*fix/i.test(tl)) return "LF";
  if (/nerve\s*fix/i.test(tl)) return "NF";
  if (/omega\s*fuel/i.test(tl)) return "OF";
  if (/core\s*essentials/i.test(tl)) return "CE";
  if (/sugar\s*defend\s*pro/i.test(tl)) return "SDP";
  if (/performance\s*forever/i.test(tl)) return "PF";
  if (/power\s*gut/i.test(tl)) return "PG";
  if (/Chandraprabha\s*Vati/i.test(tl)) return "CPV";
  if (/Vasant\s*Kusmakar\s*Ras/i.test(tl)) return "VKR";
  if (/Heart\s*Defend\s*Pro/i.test(tl)) return "HDP";
  if (/Shilajit\s*with\s*Gold/i.test(tl)) return "SWG";

  // Fallback: initials of up to first 3 words
  const words = t.split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 3).map(w => w[0].toUpperCase()).join("");
  return initials || "ITEM";
}
function buildCartSummary(ab) {
  const items = Array.isArray(ab?.items) ? ab.items : [];
  if (!items.length) return "";

  const parts = items.map(it => {
    const code = productCodeFromTitle(it.title || "");
    const qty = it?.quantity ?? 1;
    const lineMinor = (typeof it?.finalLinePrice === "number")
      ? it.finalLinePrice
      : (typeof it?.unitPrice === "number" ? it.unitPrice * qty : 0);
    const price = formatMoneyMinor(lineMinor, ab?.currency || "INR");
    return `${code} x${qty} (${price})`;
  });

  const totalStr = typeof ab?.total === "number"
    ? formatMoneyMinor(ab.total, ab?.currency || "INR")
    : "";

  return { itemsStr: parts.join(", "), totalStr };
}

/* ---------- Address helpers (REWORKED) ---------- */
function tidyOneLine(str = "") {
  return String(str)
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*$/, "")
    .trim();
}

function buildAddressStringFromAb(ab) {
  // Prefer normalized one-liner if present
  if (ab?.customerAddressText) return tidyOneLine(String(ab.customerAddressText));

  // Try structured object (from webhook normalization)
  const p = ab?.customerAddress || {};
  const parts = [p.name, p.line1, p.line2, p.city, p.state, p.postalCode, p.country]
    .map((x) => (x || "").toString().trim())
    .filter(Boolean);
  if (parts.length) return tidyOneLine(parts.join(", "));

  // Fallback from raw payload shapes
  const r = ab?.raw || {};
  const addr = r.shipping_address || r.billing_address || r.address || {};
  const alt = [
    addr.name,
    addr.address1,
    addr.address2,
    addr.city,
    addr.state || addr.province || ab?.customer?.state,
    addr.zip || addr.postal_code,
    addr.country,
  ]
    .map((x) => (x || "").toString().trim())
    .filter(Boolean)
    .join(", ");

  return tidyOneLine(alt);
}

/**
 * Append a single consolidated line to presales.notes:
 * "Address: <full> | Cart: <KJF x1 (INR 999.00), LDP x1 (...)> | Total: INR 1998.00"
 * - Idempotent: won't duplicate if same line already exists.
 */
async function appendAddressAndCartNote(customerId, ab) {
  if (!customerId || !ab) return;

  const address = buildAddressStringFromAb(ab);
  const { itemsStr, totalStr } = buildCartSummary(ab);

  // If there's nothing meaningful, skip
  if (!address && !itemsStr && !totalStr) return;

  // Compose single line
  const lineParts = [];
  if (address) lineParts.push(`Address: ${address}`);
  if (itemsStr) lineParts.push(`Cart: ${itemsStr}`);
  if (totalStr) lineParts.push(`Total: ${totalStr}`);
  const line = lineParts.join(" | ");

  // Upsert ConsultationDetails and append idempotently
  const doc = await ConsultationDetails.findOne({ customerId });
  if (!doc) {
    await ConsultationDetails.create({
      customerId,
      presales: { notes: line },
    });
    return;
  }

  const current = (doc.presales?.notes || "").trim();
  // Idempotency check: exact line already present
  if (current.split("\n").some((l) => tidyOneLine(l) === tidyOneLine(line))) return;

  const newNotes = current ? `${current}\n${line}` : line;
  await ConsultationDetails.updateOne(
    { _id: doc._id },
    { $set: { "presales.notes": newNotes } }
  );
}

/* -------------------- GET /api/abandoned -------------------- */
router.get("/", async (req, res) => {
  try {
    const {
      query = "",
      start = "",
      end = "",
      page = 1,
      limit = 50,
      assigned = "", // 'assigned' | 'unassigned'
      expertId = "", // ObjectId of Employee
      expertEmail = "", // fallback: filter by email
    } = req.query;

    const q = {};

    if (query) {
      const rx = new RegExp(escapeRegex(query.trim()), "i");
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

    // assigned / unassigned
    if (assigned === "assigned") {
      // prefer id filter, else email
      if (expertId && mongoose.Types.ObjectId.isValid(expertId)) {
        q["assignedExpert._id"] = new mongoose.Types.ObjectId(expertId);
      } else if (expertEmail) {
        q["assignedExpert.email"] = new RegExp(`^${escapeRegex(expertEmail)}$`, "i");
      } else {
        q["assignedExpert._id"] = { $exists: true };
      }
    } else if (assigned === "unassigned") {
      q["assignedExpert._id"] = { $exists: false };
    }

    // proactively auto-assign while viewing "unassigned"
    if (assigned === "unassigned") {
      await autoAssignUnassignedMatching(q, 200);
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

/* -------------------- POST /api/abandoned/:id/assign-expert -------------------- */
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

    // prefer existing expert (Customer/Lead) if any
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

      // Append consolidated Address + Cart note to the matched customer
      const n10 = normalizePhoneTo10(phone);
      const foundCustomer = await Customer.findOne({
        phone: { $regex: `${n10}$` },
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      if (foundCustomer) {
        await appendAddressAndCartNote(foundCustomer._id, ab);
      }

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

    // otherwise, assign to posted expert + create a Customer
    const firstItemTitle =
      Array.isArray(ab.items) && ab.items.length ? ab.items[0].title : "";
    // You may still use your lookingFor mapper if you like
    const lookingFor = (() => {
      const t = String(firstItemTitle).toLowerCase();
      if (/karela\s*jamun\s*fizz/.test(t)) return "Diabetes";
      if (/liver\s*fix/.test(t)) return "Fatty Liver";
      return "Others";
    })();

    const customerDoc = new Customer({
      name: ab.customer?.name || "",
      phone: phone,
      age: 0,
      location: ab.customer?.state || "", // save STATE here
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

    // Append consolidated Address + Cart note for the NEW customer
    await appendAddressAndCartNote(customerDoc._id, ab);

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
