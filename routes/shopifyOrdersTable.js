// routes/shopifyOrdersTable.js
const express = require("express");
const router = express.Router();

const ShopifyOrder = require("../models/ShopifyOrder");
const Lead = require("../models/Lead");
const Order = require("../models/Order");

// ---------- helpers ----------
function ymd(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}
function stripHashOrderName(orderName) {
  if (!orderName) return "";
  return orderName.startsWith("#") ? orderName.slice(1) : orderName;
} 
function normalizePhone10(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
} 
function mopString(order) {
  if (!order) return "";
  if (typeof order.modeOfPayment === "string" && order.modeOfPayment.trim()) {
    return order.modeOfPayment.trim();
  }
  const g = order.paymentGatewayNames;
  if (Array.isArray(g) && g.length) return g.filter(Boolean).join(", ");
  if (typeof g === "string" && g.trim()) return g.trim();
  return "";
}
 
const RAW_PRODUCT_ABBREV = {
  "Karela Jamun Fizz": "KJF",
  "Sugar Defend Pro": "SDP",
  "Vasant Kusmakar Ras": "VKR",
  "Liver Fix": "L-Fx",
  "Stress & Sleep": "S&S",
  "Chandraprabha Vati": "CPV",
  "Heart Defend Pro": "HDP",
  "Performance Forever": "PF",
  "Power Gut": "PGut",
  "Shilajit with Gold": "Shilajit",
  "Diabetes Management Kit": "Kit",
  "Core Essentials": "CE",
  "Omega Fuel": "OF",
  "Nerve FIx": "NF",
  "Thyroid Defend Pro": "TDP", 
};
const PRODUCT_ABBREV = Object.fromEntries(
  Object.entries(RAW_PRODUCT_ABBREV).map(([k, v]) => [
    k.toLowerCase().trim().replace(/\s+/g, " "),
    v
  ])
);
function normalizeTitle(t = "") {
  return String(t).toLowerCase().trim().replace(/\s+/g, " ");
}
function titleToCode(title) {
  const key = normalizeTitle(title);
  if (PRODUCT_ABBREV[key]) return PRODUCT_ABBREV[key];
  const letters = key.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase();
  return letters || key.toUpperCase();
}
 
router.get("/shopify/orders-table", async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);
    const skip  = (page - 1) * limit;

    const selectedStatus = (req.query.status || "").trim();
    const stateFilter    = (req.query.state || "").trim();
    const modeFilter     = (req.query.mode || "").trim();
    const assigned       = (req.query.assigned || "").trim().toLowerCase();  
    const onlyMeta       = String(req.query.onlyMeta || "") === "1";
    const withMeta       = String(req.query.withMeta || "") === "1";

    const startDate = (req.query.startDate || "").trim();
    const endDate   = (req.query.endDate || "").trim();
 
    const baseMatch = {};
    if (stateFilter) baseMatch["customerAddress.province"] = stateFilter;
    if (modeFilter) {
      baseMatch.$or = [
        { modeOfPayment: modeFilter },
        { paymentGatewayNames: modeFilter },
      ];
    }
    if (startDate || endDate) {
      const gte = startDate ? new Date(`${startDate}T00:00:00.000Z`) : null;
      const lte = endDate   ? new Date(`${endDate}T23:59:59.999Z`)   : null;
      const dateCond = {};
      if (gte) dateCond.$gte = gte;
      if (lte) dateCond.$lte = lte;
      const orDate = [
        { orderDate: dateCond },
        { $and: [ { orderDate: { $exists: false } }, { createdAt: dateCond } ] }
      ];
      baseMatch.$or = baseMatch.$or ? baseMatch.$or.concat(orDate) : orDate;
    }
 
    if (onlyMeta) {
      const metaPipeline = [
        { $match: baseMatch },
        {
          $addFields: {
            orderIdNoHash: {
              $let: {
                vars: { on: { $ifNull: ["$orderName", ""] } },
                in: {
                  $cond: [
                    { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                    { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                    "$$on"
                  ]
                }
              }
            },
            modeEff: { $ifNull: ["$modeOfPayment", { $arrayElemAt: ["$paymentGatewayNames", 0] }] }
          }
        },
        {
          $facet: {
            statuses: [
              { $lookup: {
                  from: "orders",
                  let: { oid: "$orderIdNoHash" },
                  pipeline: [
                    { $match: { $expr: { $eq: ["$order_id", "$$oid"] } } },
                    { $project: { _id: 0, shipment_status: 1 } }
                  ],
                  as: "o"
                }
              },
              { $addFields: { shipmentStatus: { $ifNull: [{ $arrayElemAt: ["$o.shipment_status", 0] }, "-"] } } },
              { $group: { _id: "$shipmentStatus", count: { $sum: 1 } } },
              { $project: { _id: 0, status: "$_id", count: 1 } },
              { $sort: { status: 1 } }
            ],
            states: [
              { $group: { _id: "$customerAddress.province", count: { $sum: 1 } } },
              { $project: { _id: 0, state: "$_id", count: 1 } },
              { $sort: { state: 1 } }
            ],
            modes: [
              { $group: { _id: "$modeEff", count: { $sum: 1 } } },
              { $project: { _id: 0, mode: "$_id", count: 1 } },
              { $sort: { mode: 1 } }
            ]
          }
        }
      ];
      const [meta] = await ShopifyOrder.aggregate(metaPipeline).allowDiskUse(true);
      return res.json({
        page, limit, total: 0,
        statuses: meta?.statuses || [],
        states:   meta?.states   || [],
        modes:    meta?.modes    || [],
        data: []
      });
    }
 
    const early = [{ $match: baseMatch }];

    if (selectedStatus) {
      early.push(
        {
          $addFields: {
            orderIdNoHash: {
              $let: {
                vars: { on: { $ifNull: ["$orderName", ""] } },
                in: {
                  $cond: [
                    { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                    { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                    "$$on"
                  ]
                }
              }
            }
          }
        },
        {
          $lookup: {
            from: "orders",
            let: { oid: "$orderIdNoHash" },
            pipeline: [
              { $match: { $expr: { $and: [
                { $eq: ["$order_id", "$$oid"] },
                { $eq: ["$shipment_status", selectedStatus] }
              ] } } },
              { $project: { _id: 1 } }
            ],
            as: "oMatch"
          }
        },
        { $match: { $expr: { $gt: [ { $size: "$oMatch" }, 0 ] } } },
        { $project: { oMatch: 0 } }
      );
    }
 
    early.push({ $sort: { orderDate: -1, createdAt: -1 } });
 
    const assignedPresence = [];
    if (assigned === "assigned" || assigned === "unassigned") {
      assignedPresence.push(
        {
          $addFields: {
            rawA: { $ifNull: ["$contactNumber", ""] },
            rawB: { $ifNull: ["$customerAddress.phone", ""] },
          }
        },
        {
          $lookup: {
            from: "leads",
            let: { a: "$rawA", b: "$rawB" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $and: [ { $gt: [ { $strLenCP: "$$a" }, 0 ] }, { $eq: ["$contactNumber", "$$a"] } ] },
                      { $and: [ { $gt: [ { $strLenCP: "$$b" }, 0 ] }, { $eq: ["$contactNumber", "$$b"] } ] },
                    ]
                  }
                }
              },
              { $limit: 1 },
              { $project: { _id: 1 } }
            ],
            as: "leadExist"
          }
        },
        ...(assigned === "assigned"
          ? [{ $match: { $expr: { $gt: [ { $size: "$leadExist" }, 0 ] } } }]
          : [{ $match: { $expr: { $eq: [ { $size: "$leadExist" }, 0 ] } } }]),
        { $project: { leadExist: 0 } }
      );
    }
 
    const facet = {
      rows: [
        { $skip: skip },
        { $limit: limit },
 
        {
          $project: {
            orderName: 1,
            orderDate: 1,
            createdAt: 1,
            amount: { $ifNull: ["$amount", 0] },
            modeOfPayment: 1,
            paymentGatewayNames: 1,
            productsOrdered: 1,
            channelName: { $ifNull: ["$channelName", ""] },
            customerName: { $ifNull: ["$customerName", ""] },
            contactNumber: { $ifNull: ["$contactNumber", ""] },
            rawA: { $ifNull: ["$contactNumber", ""] },
            rawB: { $ifNull: ["$customerAddress.phone", ""] },
            state: "$customerAddress.province",
          }
        },

        // Derived display fields
        {
          $addFields: {
            orderDateEff: { $ifNull: ["$orderDate", "$createdAt"] },
            modeEff: { $ifNull: ["$modeOfPayment", { $arrayElemAt: ["$paymentGatewayNames", 0] }] }
          }
        },

        // Shipment status (page-only)
        {
          $addFields: {
            orderIdNoHash: {
              $let: {
                vars: { on: { $ifNull: ["$orderName", ""] } },
                in: {
                  $cond: [
                    { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                    { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                    "$$on"
                  ]
                }
              }
            }
          }
        },
        {
          $lookup: {
            from: "orders",
            let: { oid: "$orderIdNoHash" },
            pipeline: [
              { $match: { $expr: { $eq: ["$order_id", "$$oid"] } } },
              { $project: { _id: 0, shipment_status: 1 } }
            ],
            as: "o"
          }
        },
        { $addFields: { shipmentStatus: { $ifNull: [{ $arrayElemAt: ["$o.shipment_status", 0] }, "-"] } } },

        // Latest agent & HE using EXACT match on either rawA/rawB
        {
          $lookup: {
            from: "leads",
            let: { a: "$rawA", b: "$rawB" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $and: [ { $gt: [ { $strLenCP: "$$a" }, 0 ] }, { $eq: ["$contactNumber", "$$a"] } ] },
                      { $and: [ { $gt: [ { $strLenCP: "$$b" }, 0 ] }, { $eq: ["$contactNumber", "$$b"] } ] },
                    ]
                  }
                }
              },
              { $sort: { updatedAt: -1, _id: -1 } },
              { $limit: 1 },
              {
                $project: {
                  _id: 0,
                  agentAssigned: { $trim: { input: { $ifNull: ["$agentAssigned",""] } } },
                  healthExpertAssigned: { $trim: { input: { $ifNull: ["$healthExpertAssigned",""] } } }
                }
              }
            ],
            as: "leadInfo"
          }
        },

        // Final projection
        {
          $addFields: {
            lineItemTitles: {
              $map: {
                input: { $ifNull: ["$productsOrdered", []] },
                as: "p",
                in: { $ifNull: ["$$p.title", ""] }
              }
            },
            agentAssigned: { $ifNull: [ { $arrayElemAt: ["$leadInfo.agentAssigned", 0] }, "" ] },
            healthExpertAssigned: { $ifNull: [ { $arrayElemAt: ["$leadInfo.healthExpertAssigned", 0] }, "" ] }
          }
        },
        {
          $project: {
            _id: 0,
            orderId: "$orderName",
            name: "$customerName",
            contactNumber: 1, // show order's customer number column
            orderDate: "$orderDateEff",
            amount: 1,
            modeOfPayment: "$modeEff",
            lineItemTitles: 1,
            agentAssigned: 1,
            healthExpertAssigned: 1,
            channelName: 1,
            state: 1,
            shipmentStatus: 1
          }
        }
      ],
      total: [ { $count: "count" } ]
    };

    const pipeline = [
      ...early,
      ...assignedPresence,
      { $facet: facet },
      {
        $project: {
          rows: 1,
          total: { $ifNull: [ { $arrayElemAt: ["$total.count", 0] }, 0 ] }
        }
      }
    ];

    // Optional meta (respects filters)
    let statuses = [], states = [], modes = [];
    if (withMeta) {
      const meta2 = await ShopifyOrder.aggregate([
        ...early,
        ...assignedPresence,
        {
          $addFields: {
            orderIdNoHash: {
              $let: {
                vars: { on: { $ifNull: ["$orderName", ""] } },
                in: {
                  $cond: [
                    { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                    { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                    "$$on"
                  ]
                }
              }
            },
            modeEff: { $ifNull: ["$modeOfPayment", { $arrayElemAt: ["$paymentGatewayNames", 0] }] }
          }
        },
        {
          $facet: {
            statuses: [
              { $lookup: {
                  from: "orders",
                  let: { oid: "$orderIdNoHash" },
                  pipeline: [
                    { $match: { $expr: { $eq: ["$order_id", "$$oid"] } } },
                    { $project: { _id: 0, shipment_status: 1 } }
                  ],
                  as: "o"
                }
              },
              { $addFields: { shipmentStatus: { $ifNull: [{ $arrayElemAt: ["$o.shipment_status", 0] }, "-"] } } },
              { $group: { _id: "$shipmentStatus", count: { $sum: 1 } } },
              { $project: { _id: 0, status: "$_id", count: 1 } },
              { $sort: { status: 1 } }
            ],
            states: [
              { $group: { _id: "$customerAddress.province", count: { $sum: 1 } } },
              { $project: { _id: 0, state: "$_id", count: 1 } },
              { $sort: { state: 1 } }
            ],
            modes: [
              { $group: { _id: "$modeEff", count: { $sum: 1 } } },
              { $project: { _id: 0, mode: "$_id", count: 1 } },
              { $sort: { mode: 1 } }
            ]
          }
        }
      ]).allowDiskUse(true);

      const m = meta2?.[0] || {};
      statuses = m.statuses || [];
      states   = m.states   || [];
      modes    = m.modes    || [];
    }

    const [result] = await ShopifyOrder.aggregate(pipeline).allowDiskUse(true);

    res.json({
      page,
      limit,
      total: result?.total || 0,
      statuses,
      states,
      modes,
      data: result?.rows || []
    });
  } catch (err) {
    console.error("orders-table error:", err);
    res.status(500).json({ error: "Failed to load Shopify orders table" });
  }
});

// ---------- Assign Health Expert (EXACT orderName; EXACT phone match) ----------
router.post("/leads/assign-health-expert", async (req, res) => {
  try {
    const { orderName, contactNumber, healthExpertAssigned } = req.body || {};
    if (!healthExpertAssigned)
      return res.status(400).json({ error: "healthExpertAssigned is required" });
    if (!orderName && !contactNumber)
      return res.status(400).json({ error: "Provide orderName or contactNumber" });

    const heClean = String(healthExpertAssigned || "").replace(/"/g, "").trim();
    if (!heClean) return res.status(400).json({ error: "healthExpertAssigned empty after cleaning" });

    // EXACT orderName only (as shown in row)
    const orOrder = [];
    if (orderName) orOrder.push({ orderName });
    if (contactNumber) orOrder.push({ contactNumber });

    const shopOrder = await ShopifyOrder.findOne(orOrder.length ? { $or: orOrder } : {})
      .sort({ orderDate: -1, createdAt: -1 });

    const rawA = shopOrder?.contactNumber || "";
    const rawB = shopOrder?.customerAddress?.phone || "";
    const inputRaw = contactNumber || "";
    const phoneCandidates = [inputRaw, rawA, rawB].filter(v => typeof v === "string" && v.trim() !== "");

    // Find existing lead by EXACT equality on any candidate
    let existingLead = null;
    for (const raw of phoneCandidates) {
      const found = await Lead.findOne({ contactNumber: raw }).sort({ updatedAt: -1, _id: -1 }).lean();
      if (found) { existingLead = found; break; }
    }

    const codes = Array.isArray(shopOrder?.productsOrdered)
      ? shopOrder.productsOrdered
          .map(p => p?.title || "")
          .filter(Boolean)
          .map(title => PRODUCT_ABBREV[normalizeTitle(title)] || titleToCode(title))
      : [];

    const orderNameForLead = shopOrder?.orderName || orderName || "";
    const dateStr = ymd(shopOrder?.orderDate || shopOrder?.createdAt || new Date());
    const mop = mopString(shopOrder);

    // choose best number to store on Lead: prefer order contactNumber, else address phone, else input
    const bestPhone = rawA || rawB || inputRaw || "";

    if (existingLead) {
      const update = {
        healthExpertAssigned: heClean,
        agentAssigned: existingLead.agentAssigned || "Online Order",
        orderId: orderNameForLead,
        contactNumber: bestPhone || existingLead.contactNumber
      };
      if (codes.length) update.productsOrdered = codes;
      await Lead.updateOne({ _id: existingLead._id }, { $set: update });
      return res.json({ ok: true, updated: true, leadId: existingLead._id });
    }

    const created = await Lead.create({
      orderId: orderNameForLead,
      name: shopOrder?.customerName || "",
      contactNumber: bestPhone,
      date: dateStr,
      lastOrderDate: dateStr,
      amountPaid: Number(shopOrder?.amount) || 0,
      modeOfPayment: mop,
      productsOrdered: codes,
      agentAssigned: "Online Order",
      healthExpertAssigned: heClean,
      leadStatus: "Sales Done",
      salesStatus: "Sales Done",
    });

    return res.json({ ok: true, created: true, leadId: created._id });
  } catch (err) {
    console.error("assign-health-expert error:", err);
    res.status(500).json({ error: "Failed to assign health expert" });
  }
});

module.exports = router;
  