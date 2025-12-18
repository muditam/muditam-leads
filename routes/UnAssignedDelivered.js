

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


    if (unassignedPhones.length === 0) {
      return res.json({
        count: 0,
        cacheAgeMs: Date.now() - phoneCache.builtAt,
      });
    }


    const match = {
      shipment_status: "Delivered",
      contact_number: { $in: unassignedPhones },
      order_id: { $regex: /^MA\d+$/ }, 
    };


    if (startDate) {
      const sd = new Date(startDate);
      if (!isNaN(sd)) {
        match.order_date = { $gte: sd };
      }
    }

    const result = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$contact_number",
        },
      },
      { $count: "count" },
    ]);


    const count = result[0]?.count || 0;


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


    const sortOrder =
      (req.query.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;


    const sortField = "order_date";  


    const { unassignedPhones } = await getPhoneSets({
      force: req.query.refresh === "1",
      startDate,
    });


    if (unassignedPhones.length === 0) {
      return res.json({
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      });
    }


    const matchStage = {
      shipment_status: "Delivered",
      contact_number: { $in: unassignedPhones },
    };


    if (startDate) {
      const sd = new Date(startDate);
      if (!isNaN(sd)) {
        matchStage.order_date = { $gte: sd };
      }
    }


 const pipeline = [
  {
    $match: {
      shipment_status: "Delivered",
      contact_number: { $in: unassignedPhones },
      order_id: { $regex: /^MA\d+$/ }, 
    },
  },

  { $sort: { order_date: sortOrder } },

  {
    $group: {
      _id: "$contact_number",
      order_id: { $first: "$order_id" },
      full_name: { $first: "$full_name" },
      shipment_status: { $first: "$shipment_status" },
      contact_number: { $first: "$contact_number" },
      order_date: { $first: "$order_date" },
      last_updated_at: { $first: "$last_updated_at" },
    },
  },




  { $sort: { order_date: sortOrder } },




  { $skip: skip },
  { $limit: limit },
];


    const data = await Order.aggregate(pipeline);


    const total = unassignedPhones.length;
    const totalPages = Math.ceil(total / limit);


    res.json({
      page,
      limit,
      total,
      totalPages,
      data,
    });
  } catch (err) {
    console.error("unassigned-delivered error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
router.post("/assign-employee", async (req, res) => {
  try {
    const { phone, employeeId } = req.body;


    if (!phone || !employeeId) {
      return res.status(400).json({ error: "phone and employeeId required" });
    }


    const employee = await require("../models/Employee").findById(employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }


    const normalized = String(phone).replace(/\D/g, "").slice(-10);


    let lead = await Lead.findOne({ contactNumber: normalized });


    if (!lead) {
      lead = await Lead.create({
        contactNumber: normalized,
        leadSource: "Unassigned Delivered",
      });
    }


    if (employee.role.toLowerCase().includes("sales")) {
      lead.agentAssigned = employee._id;
    }


    if (employee.role.toLowerCase().includes("retention")) {
      lead.healthExpertAssigned = employee._id;
    }


    await lead.save();


    res.json({ success: true });
  } catch (err) {
    console.error("assign-employee error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
router.post("/update-lead-from-unassigned", async (req, res) => {
  try {
    const {
      name,
      contactNumber,
      orderId,
      orderDate,
      assignedName,
    } = req.body;


    if (!contactNumber || !assignedName) {
      return res.status(400).json({
        error: "contactNumber and assignedName are required",
      });
    }


    const normalizedContact = String(contactNumber)
      .replace(/\D/g, "")
      .slice(-10);


    let lead = await Lead.findOne({ contactNumber: normalizedContact });


    if (!lead) {
      const now = new Date();


      lead = new Lead({
        contactNumber: normalizedContact,
        leadSource: "Unassigned Delivered",
        date: now.toISOString().slice(0, 10), // YYYY-MM-DD
        time: now.toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      });
    }




    lead.name = name || lead.name;
    lead.contactNumber = normalizedContact;
    lead.orderId = orderId;
    lead.healthExpertAssigned = assignedName;
    lead.leadStatus = "Sales Done";
    lead.salesStatus = "Sales Done";
    lead.agentAssigned = "Online Order";


    if (orderDate) {
      lead.lastOrderDate = new Date(orderDate)
        .toISOString()
        .slice(0, 10);
    }


    await lead.save();


    res.json({ success: true });
  } catch (err) {
    console.error("update-lead-from-unassigned error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


module.exports = router;
