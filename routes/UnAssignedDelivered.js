// routes/orders-un.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");


const TTL_MS = 5 * 60 * 1000;




let phoneCache = {
  leadSet: new Set(),
  custSet: new Set(),
  unassignedPhones: [],
  builtAt: 0,
  building: null,
  key: "ALL",
};


function normalizeTo10(str = "") {
  const s = String(str).replace(/\D/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}




async function buildPhoneSetsFresh(startDate, key) {
  const leadSet = new Set();
  const custSet = new Set();




  const leadCur = Lead.find(
    { contactNumber: { $exists: true, $ne: null, $ne: "" } },
    { contactNumber: 1, _id: 0 }
  )
    .lean()
    .cursor();


  for await (const d of leadCur) {
    const n = normalizeTo10(d.contactNumber);
    if (n) leadSet.add(n);
  }


  const custCur = Customer.find(
    { phone: { $exists: true, $ne: null, $ne: "" } },
    { phone: 1, _id: 0 }
  )
    .lean()
    .cursor();


  for await (const d of custCur) {
    const n = normalizeTo10(d.phone);
    if (n) custSet.add(n);
  }


  const match = {
    shipment_status: "Delivered",
    contact_number: { $exists: true, $ne: "" },
  };


  if (startDate) {
    const sd = new Date(startDate);
    if (!isNaN(sd)) {
      match.order_date = { $gte: sd };
    }
  }


  const rawPhones = await Order.distinct("contact_number", match);


  const unassignedPhones = [];
  for (const p of rawPhones) {
    const n = normalizeTo10(p);
    if (!n) continue;
    if (!leadSet.has(n) && !custSet.has(n)) {


      unassignedPhones.push(p);
    }
  }


  phoneCache = {
    leadSet,
    custSet,
    unassignedPhones,
    builtAt: Date.now(),
    building: null,
    key,
  };


  return phoneCache;
}




async function getPhoneSets({ force = false, startDate = null } = {}) {
  const key = startDate || "ALL";
  const fresh =
    Date.now() - phoneCache.builtAt < TTL_MS && phoneCache.key === key;


  if (!force && fresh) return phoneCache;


  if (phoneCache.building) return phoneCache.building;


  phoneCache.building = buildPhoneSetsFresh(startDate, key);
  return phoneCache.building;
}


router.get("/unassigned-delivered-count", async (req, res) => {
  try {
    const { startDate } = req.query;


    const { unassignedPhones } = await getPhoneSets({
      force: req.query.refresh === "1",
      startDate,
    });


    const count = unassignedPhones.length;


    res.json({
      count,
      cacheAgeMs: Date.now() - phoneCache.builtAt,
    });
  } catch (err) {
    console.error("unassigned-delivered-count error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});




router.get("/unassigned-delivered", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200
    );
    const skip = (page - 1) * limit;


    const { startDate } = req.query;


  const requestedSortBy = req.query.sortBy || "order_date";
const sortOrder =
  (req.query.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;


// only allow known sortable fields to avoid bad input
const allowedSortFields = ["last_updated_at", "order_date"];
const sortBy = allowedSortFields.includes(requestedSortBy)
  ? requestedSortBy
  : "order_date";


const sortStage = {};
sortStage[sortBy] = sortOrder;
sortStage.last_updated_at = sortOrder;


    const { unassignedPhones } = await getPhoneSets({
      force: req.query.refresh === "1",
      startDate,
    });


    const total = unassignedPhones.length;
    const totalPages = total > 0 ? Math.ceil(total / limit) : 1;


    // slice only the phone numbers for this page
    const pagePhones = unassignedPhones.slice(skip, skip + limit);


    if (pagePhones.length === 0) {
      return res.json({
        page,
        limit,
        total,
        totalPages,
        data: [],
        cacheAgeMs: Date.now() - phoneCache.builtAt,
      });
    }


    // match only orders in the same date range
    const matchStage = {
      shipment_status: "Delivered",
      contact_number: { $in: pagePhones },
    };


    if (startDate) {
      const sd = new Date(startDate);
      if (!isNaN(sd)) {
        matchStage.order_date = { $gte: sd };
      }
    }


  const data = await Order.aggregate([
  { $match: matchStage },
  { $sort: sortStage }, // ensure "latest" comes first
  {
    $group: {
      _id: "$contact_number",
      order_id: { $first: "$order_id" },
      shipment_status: { $first: "$shipment_status" },
      contact_number: { $first: "$contact_number" },
      order_date: { $first: "$order_date" },
       full_name: { $first: "$full_name" },
      last_updated_at: { $first: "$last_updated_at" },
    },
  },
  { $sort: sortStage },
]);




    res.json({
      page,
      limit,
      total,
      totalPages,
      data,
      cacheAgeMs: Date.now() - phoneCache.builtAt,
    });
  } catch (err) {
    console.error("unassigned-delivered error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


module.exports = router;



