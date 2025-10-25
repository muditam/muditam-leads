// routes/orders-un.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");

// -------------------- helpers --------------------
const TTL_MS = 5 * 60 * 1000; // cache phones for 5 minutes
let phoneCache = { leadSet: new Set(), custSet: new Set(), builtAt: 0, building: null };

function normalizeTo10(str = "") {
  const s = String(str).replace(/\D/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}

async function buildPhoneSetsFresh() {
  const leadSet = new Set();
  const custSet = new Set();

  // stream minimal fields
  const leadCur = Lead.find(
    { contactNumber: { $exists: true, $ne: null, $ne: "" } },
    { contactNumber: 1, _id: 0 } 
  ).lean().cursor();
  for await (const d of leadCur) {
    const n = normalizeTo10(d.contactNumber); 
    if (n) leadSet.add(n);  
  } 

  const custCur = Customer.find(
    { phone: { $exists: true, $ne: null, $ne: "" } },
    { phone: 1, _id: 0 }
  ).lean().cursor(); 
  for await (const d of custCur) {
    const n = normalizeTo10(d.phone); 
    if (n) custSet.add(n);
  }

  phoneCache = { leadSet, custSet, builtAt: Date.now(), building: null };
  return phoneCache;
}

// returns cached or building promise to avoid stampede
async function getPhoneSets({ force = false } = {}) {
  const fresh = Date.now() - phoneCache.builtAt < TTL_MS;
  if (!force && fresh) return phoneCache;
  if (phoneCache.building) return phoneCache.building; // reuse in-flight build
  phoneCache.building = buildPhoneSetsFresh();
  return phoneCache.building;
}

// -------------------- COUNT: fast path --------------------
// GET /api/orders-un/unassigned-delivered-count?refresh=1
router.get("/unassigned-delivered-count", async (req, res) => {
  try {
    const { leadSet, custSet } = await getPhoneSets({ force: req.query.refresh === "1" });

    // Avoid heavy aggregation: just distinct delivered contact numbers
    const rawPhones = await Order.distinct("contact_number", {
      shipment_status: "Delivered",
      contact_number: { $exists: true, $ne: "" } 
    });

    let count = 0;
    for (const p of rawPhones) {
      const n = normalizeTo10(p);
      if (n && !leadSet.has(n) && !custSet.has(n)) count++;
    }

    res.json({ count, cacheAgeMs: Date.now() - phoneCache.builtAt });
  } catch (err) {
    console.error("unassigned-delivered-count error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------- LIST: paginated -------------------- 
// Shows order_id, shipment_status, contact_number, order_date (normalized compare)
router.get("/unassigned-delivered", async (req, res) => { 
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200); 
    const skip = (page - 1) * limit;

    const sortBy = req.query.sortBy || "last_updated_at";
    const sortOrder = (req.query.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;

    const { leadSet, custSet } = await getPhoneSets({ force: req.query.refresh === "1" });

    // Stream delivered orders; filter by normalized phone against cached sets
    const cur = Order.find(
      { shipment_status: "Delivered", contact_number: { $exists: true, $ne: "" } },
      { order_id: 1, shipment_status: 1, contact_number: 1, order_date: 1, last_updated_at: 1, _id: 0 }
    )
      .sort({ [sortBy]: sortOrder, _id: 1 })
      .lean()
      .cursor();

    const data = [];  
    let total = 0; 
    let accepted = 0;

    for await (const o of cur) {
      const n = normalizeTo10(o.contact_number);
      if (!n) continue;
      if (!leadSet.has(n) && !custSet.has(n)) {
        if (accepted >= skip && data.length < limit) {
          data.push(o);
        }
        accepted++;
        total++;
      }
    }

    res.json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      data,
      cacheAgeMs: Date.now() - phoneCache.builtAt
    });
  } catch (err) {
    console.error("unassigned-delivered error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

