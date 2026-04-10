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

  const retention = unique.find(
    (c) => (c.role || "").toLowerCase() === "retention agent"
  );
  if (retention) return retention;

  const sales = unique.find(
    (c) => (c.role || "").toLowerCase() === "sales agent"
  );
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

/* ---------- Money & cart helpers ---------- */
function formatMoneyMinor(minor, currency = "INR") {
  if (typeof minor !== "number") return "";
  const n = minor / 100;
  return `${currency} ${n.toFixed(2)}`;
}

function productCodeFromTitle(title = "") {
  const t = String(title).trim();
  const tl = t.toLowerCase();

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

  const words = t.split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 3).map((w) => w[0].toUpperCase()).join("");
  return initials || "ITEM";
}

function buildCartSummary(ab) {
  const items = Array.isArray(ab?.items) ? ab.items : [];
  if (!items.length) return { itemsStr: "", totalStr: "" };

  const parts = items.map((it) => {
    const code = productCodeFromTitle(it.title || "");
    const qty = it?.quantity ?? 1;
    const lineMinor =
      typeof it?.finalLinePrice === "number"
        ? it.finalLinePrice
        : typeof it?.unitPrice === "number"
          ? it.unitPrice * qty
          : 0;

    const price = formatMoneyMinor(lineMinor, ab?.currency || "INR");
    return `${code} x${qty} (${price})`;
  });

  const totalStr =
    typeof ab?.total === "number"
      ? formatMoneyMinor(ab.total, ab?.currency || "INR")
      : "";

  return { itemsStr: parts.join(", "), totalStr };
}

/* ---------- Address helpers ---------- */
function tidyOneLine(str = "") {
  return String(str)
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*$/, "")
    .trim();
}

function personName(obj = {}) {
  const full = [obj.firstname, obj.lastname]
    .map((x) => (x || "").toString().trim())
    .filter(Boolean)
    .join(" ");
  return full || (obj.name || "").toString().trim();
}

function joinAddressParts(parts = []) {
  return tidyOneLine(
    parts
      .map((x) => (x || "").toString().trim())
      .filter(Boolean)
      .join(", ")
  );
}

function addressScore(str = "") {
  return String(str)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean).length;
}

function buildAddressStringFromAb(ab) {
  const p = ab?.customerAddress || {};
  const r = ab?.raw || {};
  const addr = r.shipping_address || r.billing_address || r.address || {};

  const fromText = tidyOneLine(ab?.customerAddressText || "");

  const fromStructured = joinAddressParts([
    p.name,
    p.line1,
    p.line2,
    p.city,
    p.state,
    p.postalCode,
    p.country,
  ]);

  const fromRaw = joinAddressParts([
    personName(addr),
    addr.address1 || addr.address,
    addr.address2,
    addr.city,
    addr.state || addr.province || ab?.customer?.state,
    addr.zip || addr.postal_code || addr.pincode,
    addr.country,
  ]);

  const best = [fromStructured, fromRaw, fromText]
    .filter(Boolean)
    .sort((a, b) => {
      const diff = addressScore(b) - addressScore(a);
      if (diff !== 0) return diff;
      return b.length - a.length;
    })[0];

  return best || "";
}

function buildStateOnlyFromAb(ab) {
  const p = ab?.customerAddress || {};
  const r = ab?.raw || {};
  const addr = r.shipping_address || r.billing_address || r.address || {};

  return String(
    p.state ||
      addr.state ||
      addr.province ||
      r.state ||
      r.province ||
      ab?.customer?.state ||
      ""
  ).trim();
}

/**
 * Notes should contain FULL address.
 * If an abandoned-cart note line already exists, replace it instead of duplicating it.
 */
async function appendAddressAndCartNote(customerId, ab) {
  if (!customerId || !ab) return;

  const address = buildAddressStringFromAb(ab);
  const { itemsStr, totalStr } = buildCartSummary(ab);

  if (!address && !itemsStr && !totalStr) return;

  const lineParts = [];
  if (address) lineParts.push(`Address: ${address}`);
  if (itemsStr) lineParts.push(`Cart: ${itemsStr}`);
  if (totalStr) lineParts.push(`Total: ${totalStr}`);

  const line = lineParts.join(" | ");

  const doc = await ConsultationDetails.findOne({ customerId });

  if (!doc) {
    await ConsultationDetails.create({
      customerId,
      presales: { notes: line },
    });
    return;
  }

  const current = (doc.presales?.notes || "").trim();

  if (!current) {
    await ConsultationDetails.updateOne(
      { _id: doc._id },
      { $set: { "presales.notes": line } }
    );
    return;
  }

  const existingLines = current.split("\n");
  const normalizedNewLine = tidyOneLine(line);

  const exactMatchIndex = existingLines.findIndex(
    (l) => tidyOneLine(l) === normalizedNewLine
  );
  if (exactMatchIndex !== -1) return;

  const abandonedCartLineIndex = existingLines.findIndex((l) => {
    const t = tidyOneLine(l);
    return /^Address:/i.test(t) && /\|\s*Cart:/i.test(t) && /\|\s*Total:/i.test(t);
  });

  let nextNotes = "";

  if (abandonedCartLineIndex !== -1) {
    existingLines[abandonedCartLineIndex] = line;
    nextNotes = existingLines.join("\n").trim();
  } else {
    nextNotes = `${current}\n${line}`.trim();
  }

  await ConsultationDetails.updateOne(
    { _id: doc._id },
    { $set: { "presales.notes": nextNotes } }
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
      assigned = "",
      expertId = "",
      expertEmail = "",
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

    if (assigned === "assigned") {
      if (expertId && mongoose.Types.ObjectId.isValid(expertId)) {
        q["assignedExpert._id"] = new mongoose.Types.ObjectId(expertId);
      } else if (expertEmail) {
        q["assignedExpert.email"] = new RegExp(
          `^${escapeRegex(expertEmail)}$`,
          "i"
        );
      } else {
        q["assignedExpert._id"] = { $exists: true };
      }
    } else if (assigned === "unassigned") {
      q["assignedExpert._id"] = { $exists: false };
    }

    if (assigned === "unassigned") {
      await autoAssignUnassignedMatching(q, 200);
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 50, 1);
    const skip = (pageNum - 1) * pageSize;

    const [items, total] = await Promise.all([
      AbandonedCheckout.find(q)
        .sort({ eventAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
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

    const fullAddress = buildAddressStringFromAb(ab) || "";
    const stateOnly = buildStateOnlyFromAb(ab) || "";
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

      const n10 = normalizePhoneTo10(phone);
      const foundCustomer = await Customer.findOne({
        phone: { $regex: `${n10}$` },
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      if (foundCustomer) {
        if (stateOnly) {
          await Customer.updateOne(
            { _id: foundCustomer._id },
            {
              $set: {
                location: stateOnly,
              },
            }
          );
        }

        await appendAddressAndCartNote(foundCustomer._id, ab);
      }

      return res.json({
        ok: true,
        assignedAt: new Date().toISOString(),
        address: fullAddress,
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

    const firstItemTitle =
      Array.isArray(ab.items) && ab.items.length ? ab.items[0].title : "";

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
      location: stateOnly || "",
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

    await appendAddressAndCartNote(customerDoc._id, ab);

    return res.json({
      ok: true,
      assignedAt: new Date().toISOString(),
      address: fullAddress,
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