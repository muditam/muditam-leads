
const express = require("express");
const router = express.Router();
const ShopifyOrder = require("../models/ShopifyOrder");
const Lead = require("../models/Lead"); 
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder");
const Escalation = require("../models/escalation.model");
const DietPlan = require("../models/DietPlan");
const Employee = require("../models/Employee");
function getDateFilter(start, end) {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T23:59:59.999Z`);
  
  return {
    shopifyCreatedAt: { $gte: startDate, $lte: endDate }
  };
}
const cache = new Map();

function setCache(key, data, ttlMs = 30000) {  
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
 
const CHANNEL_MAP = {
  "Online Order": "252664381441",
  Team: "205650526209",
};

// Date helper
function getRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return { s, e };
}


function formatYMD(date) {
  return date.toISOString().slice(0, 10);
}

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

function calcMyOrderAmount(order) {
  const qty = order?.quantity || 1;
  const price = order?.mrp || 0;
  return qty * price;
}
const TIME_SLOTS = [
  { label: "11 AM", startHour: 10, endHour: 13 },
  { label: "2 PM", startHour: 13, endHour: 17 },
  { label: "7 PM", startHour: 17, endHour: 21 },
];

function computeTimeSlots(orders, dateStr) {
  return TIME_SLOTS.map(slot => {
    let count = 0;
    let totalAmount = 0;

    orders.forEach(o => {
      const d = new Date(o.shopifyCreatedAt);
      const key = d.toISOString().slice(0, 10);
      const hr = d.getUTCHours();

      if (key === dateStr && hr >= slot.startHour && hr < slot.endHour) {
        count++;
        totalAmount += o.amount;
      }
    });

    return {
      label: slot.label,
      current: count ? totalAmount / count : 0,
    };
  });
}

router.get("/orders", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    // 🔥 CACHE KEY
    const cacheKey = `orders_${start}_${end}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    const ONLINE_ID = CHANNEL_MAP["Online Order"];
    const TEAM_ID = CHANNEL_MAP.Team;

    const allOrders = await ShopifyOrder.find({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    })
      .select("channelName orderConfirmOps.assignedAgentName amount")
      .lean();

    let onlineCount = 0;
    let teamCount = 0;
    let uncategorized = 0;

    allOrders.forEach((order) => {
      const hasAgent =
        order.orderConfirmOps?.assignedAgentName &&
        order.orderConfirmOps.assignedAgentName.trim() !== "";

      const channel = order.channelName;

      if (hasAgent || channel === TEAM_ID) teamCount++;
      else if (channel === ONLINE_ID && !hasAgent) onlineCount++;
      else uncategorized++;
    });

    const response = {
      onlineOrders: onlineCount,
      teamOrders: teamCount,
      uncategorized,
      total: allOrders.length,
    };

    // 🔥 SAVE TO CACHE
    setCache(cacheKey, response);

    return res.json(response);
  } catch (err) {
    console.error("ORDER SPLIT ERROR:", err);
    res.status(500).json({ error: "Failed to split orders" });
  }
});

router.get("/first-vs-returning", async (req, res) => {
  try {
    let { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end date required" });
    }

    const startDate = new Date(start + "T00:00:00.000Z");
    const endDate = new Date(end + "T23:59:59.999Z");

    // Fetch all orders in range
    const orders = await ShopifyOrder.find(
      {
        orderDate: { $gte: startDate, $lte: endDate },
        normalizedPhone: { $exists: true, $ne: "" },
      },
      { normalizedPhone: 1 }
    ).lean();

    if (!orders.length) {
      return res.json({ firstTime: 0, returning: 0 });
    }

    const phones = orders.map(o => o.normalizedPhone);

    // Count total orders of these phones in entire DB
    const totals = await ShopifyOrder.aggregate([
      { $match: { normalizedPhone: { $in: phones } } },
      { $group: { _id: "$normalizedPhone", count: { $sum: 1 } } }
    ]);

    let firstTime = 0;
    let returning = 0;

    for (const t of totals) {
      if (t.count > 1) returning++;
      else firstTime++;
    }

    res.json({ firstTime, returning });

  } catch (err) {
    console.error("first-vs-returning analytics error:", err);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

router.get("/leads", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end date required" });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    // IMPORT LEAD MODEL
    const Lead = require("../models/Lead");

    // TOTAL leads created inside date range
    const totalLeads = await Lead.countDocuments({
      date: { $gte: start, $lte: end },
    });

    // CONTACTED leads: leadStatus != "New" (means contacted)
    const contacted = await Lead.countDocuments({
      date: { $gte: start, $lte: end },
      leadStatus: { $ne: "New" },
    });

    res.json({ totalLeads, contacted });

  } catch (err) {
    console.error("LEADS ANALYTICS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch lead analytics" });
  }
});
router.get("/delivered", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const dateFilter = getDateFilter(start, end);

    // Check Order model for delivered shipments
    const delivered = await Order.countDocuments({
      shipment_status: { $regex: /^delivered$/i },
      order_date: { 
        $gte: new Date(`${start}T00:00:00.000Z`), 
        $lte: new Date(`${end}T23:59:59.999Z`) 
      }
    });

    return res.json({ delivered });
  } catch (err) {
    console.error("Delivered analytics error:", err);
    res.status(500).json({ error: "Failed to fetch delivered count" });
  }
});
router.get("/first-vs-returning", async (req, res) => {
  try {
    let { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end date required" });
    }

    const dateFilter = getDateFilter(start, end);

    const orders = await ShopifyOrder.find(
      {
        ...dateFilter,
        normalizedPhone: { $exists: true, $ne: "" }
      },
      { normalizedPhone: 1 }
    ).lean();

    if (!orders.length) {
      return res.json({ firstTime: 0, returning: 0 });
    }

    const phones = orders.map(o => o.normalizedPhone);

    // Count total orders of these phones in entire DB
    const totals = await ShopifyOrder.aggregate([
      { $match: { normalizedPhone: { $in: phones } } },
      { $group: { _id: "$normalizedPhone", count: { $sum: 1 } } }
    ]);

    let firstTime = 0;
    let returning = 0;

    for (const t of totals) {
      if (t.count > 1) returning++;
      else firstTime++;
    }

    res.json({ firstTime, returning });

  } catch (err) {
    console.error("first-vs-returning analytics error:", err);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});




router.get("/leads-contacted", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const contacted = await Lead.countDocuments({
      "reachoutLogs.timestamp": { $gte: startDate, $lte: endDate }
    });

    res.json({ contacted });
  } catch (err) {
    console.error("CONTACTED LEADS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch contacted leads" });
  }
});

// router.get("/calls", async (req, res) => {
//   try {
//     let { start, end } = req.query;

//     if (!start || !end) {
//       return res.status(400).json({ error: "start and end required" });
//     }

//     // Do NOT convert to UTC — DB stores plain IST strings
//     // Example: “2025-01-30”
//     const s = start.trim();
//     const e = end.trim();

//     // Query SmartfloDaily by STRING date (exact match)
//     const docs = await SmartfloDaily.find({
//       date: { $gte: s, $lte: e }
//     }).lean();

//     let incoming = 0;
//     let outgoing = 0;

//     docs.forEach((d) => {
//       const sum = d.summary || {};
//       incoming += sum.incomingCalls || 0;
//       outgoing += sum.dialledCalls || 0;
//     });

//     return res.json({ incoming, outgoing });

//   } catch (err) {
//     console.error("CALL ANALYTICS ERROR:", err);
//     res.status(500).json({ error: "Failed to fetch call analytics" });
//   }
// });


router.get("/delivered", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // ✅ Count delivered from ShopifyOrder model
    const delivered = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { 
        $gte: startDate, 
        $lte: endDate 
      },
      shipment_status: "Delivered"
    });

    console.log(`📊 DELIVERED [${start} to ${end}]: ${delivered}`);

    return res.json({ delivered });
  } catch (err) {
    console.error("Delivered analytics error:", err);
    res.status(500).json({ error: "Failed to fetch delivered count" });
  }
});

// ✅ RTO endpoint using Order model (order.js schema)
router.get("/rto", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // ✅ Count RTO orders from Order model (order.js)
    const rto = await Order.countDocuments({
      order_date: { 
        $gte: startDate, 
        $lte: endDate 
      },
      shipment_status: "RTO"  // Exact match
    });

    // ✅ Count RTO Delivered orders from Order model (order.js)
    const rtoDelivered = await Order.countDocuments({
      order_date: { 
        $gte: startDate, 
        $lte: endDate 
      },
      shipment_status: "RTO Delivered"  // Exact match
    });

    // ✅ Total RTO (RTO + RTO Delivered)
    const totalRto = rto + rtoDelivered;

    console.log(`📊 RTO [${start} to ${end}]:`, { 
      rto, 
      rtoDelivered, 
      totalRto,
      source: 'Order model (order.js)'
    });

    return res.json({ 
      rto, 
      rtoDelivered, 
      totalRto 
    });

  } catch (err) {
    console.error("RTO ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch RTO analytics" });
  }
});
router.get("/aov", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    // 🔥 CACHE CHECK
    const cacheKey = `aov_${start}_${end}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    const orders = await ShopifyOrder.find({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      amount: { $gt: 0 },
    }).lean();

    const ONLINE_ID = CHANNEL_MAP["Online Order"];
    const TEAM_ID = CHANNEL_MAP.Team;

    const isTeamOrder = (o) =>
      !!(
        o.orderConfirmOps?.assignedAgentName ||
        o.channelName === TEAM_ID
      );

    const isOnlineOrder = (o) =>
      o.channelName === ONLINE_ID &&
      (!o.orderConfirmOps?.assignedAgentName ||
        o.orderConfirmOps.assignedAgentName.trim() === "");

    const calcAOV = (arr) => {
      if (!arr.length) return { aov: 0, orders: 0 };
      const total = arr.reduce((s, o) => s + o.amount, 0);
      return {
        aov: Math.round(total / arr.length),
        orders: arr.length,
      };
    };

    const online = calcAOV(orders.filter(isOnlineOrder));
    const team = calcAOV(orders.filter(isTeamOrder));
    const combined = calcAOV(orders);

    const response = { online, team, combined };

    // 🔥 SAVE
    setCache(cacheKey, response);

    return res.json(response);
  } catch (err) {
    console.error("AOV ERROR:", err);
    return res.status(500).json({ error: "Failed to compute AOV" });
  }
});




router.get("/followups", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    // rtNextFollowupDate is STRING in format YYYY-MM-DD (as per your UI)
    const follows = await Lead.countDocuments({
      rtNextFollowupDate: { $gte: start, $lte: end }
    });

    return res.json({ followUpsDue: follows });

  } catch (err) {
    console.error("FOLLOWUP ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch follow-up analytics" });
  }
});

router.get("/no-consult", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    // Leads created inside range (using date STRING)
    const dateMatch = { date: { $gte: start, $lte: end } };

    // rtNextFollowupDate missing OR empty
    const noConsultMatch = {
      $or: [
        { rtNextFollowupDate: { $exists: false } },
        { rtNextFollowupDate: "" },
        { rtNextFollowupDate: null }
      ]
    };

    const noConsultCount = await Lead.countDocuments({
      ...dateMatch,
      ...noConsultMatch
    });

    return res.json({ noConsult: noConsultCount });

  } catch (err) {
    console.error("NO CONSULT ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch no-consult analytics" });
  }
});

router.get("/ndr", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    // NDR = Not RTO, Not RTO Delivered, Not Delivered
    const ndr = await ShopifyOrder.countDocuments({
      orderDate: { $gte: startDate, $lte: endDate },
      shipment_status: {
        $nin: [
          /delivered/i,       // Delivered
          /rto/i,             // RTO
          /rto delivered/i    // RTO Delivered
        ]
      }
    });

    return res.json({ ndr });

  } catch (err) {
    console.error("NDR ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch NDR count" });
  }
});
router.get("/loss", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    const loss = await Order.countDocuments({
      order_date: { $gte: startDate, $lte: endDate },
      $or: [
        { shipment_status: "RTO" },
        { shipment_status: "RTO Delivered" },
        { is_lost: true }
      ]
    });

    return res.json({ loss });

  } catch (err) {
    console.error("LOSS ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch loss count" });
  }
});

router.get("/escalations", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    // 👇 Treat both "Open" and "In Progress" as OPEN
    const OPEN_STATUSES = ["Open", "In Progress"];

    const open = await Escalation.countDocuments({
      status: { $in: OPEN_STATUSES },
      createdAt: { $gte: startDate, $lte: endDate },
    });

    const closed = await Escalation.countDocuments({
      status: "Closed",
      createdAt: { $gte: startDate, $lte: endDate },
    });

    return res.json({ open, closed });
  } catch (err) {
    console.error("ESCALATION ANALYTICS ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch escalation stats" });
  }
});
// routes/superAdminAnalytics.js

router.get("/diet-plans", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // Count by createdAt (diet plan created date)
    const count = await DietPlan.countDocuments({
      createdAt: { $gte: startDate, $lte: endDate }
    });

    return res.json({ totalDietPlans: count });

  } catch (err) {
    console.error("DIET PLAN COUNT ERROR:", err);
    res.status(500).json({ error: "Failed to fetch diet plan count" });
  }
});
// routes/superAdminAnalytics.js






router.get("/cohort-analysis", async (req, res) => {
  try {
    const { start, end } = req.query;

    // Default: last 12 months
    const endDate = end ? new Date(end) : new Date();
    const startDate = start
      ? new Date(start)
      : new Date(new Date().setMonth(endDate.getMonth() - 11));

    const agg = await ShopifyOrder.aggregate([
      {
        $match: {
          orderDate: { $gte: startDate, $lte: endDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },

      { $sort: { normalizedPhone: 1, orderDate: 1 } },

      {
        $group: {
          _id: "$normalizedPhone",
          dates: { $push: "$orderDate" }
        }
      },

      // compute first order + monthly differences
      {
        $project: {
          firstOrder: { $arrayElemAt: ["$dates", 0] },
          monthsDiff: {
            $map: {
              input: "$dates",
              as: "d",
              in: {
                $subtract: [
                  { $add: [{ $multiply: [{ $year: "$$d" }, 12] }, { $month: "$$d" }] },
                  {
                    $add: [
                      { $multiply: [{ $year: { $arrayElemAt: ["$dates", 0] } }, 12] },
                      { $month: { $arrayElemAt: ["$dates", 0] } }
                    ]
                  }
                ]
              }
            }
          }
        }
      },

      // group customers into cohorts
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m", date: "$firstOrder" }
          },
          customers: { $sum: 1 },
          monthArrays: { $push: "$monthsDiff" }
        }
      },

      // convert counts to percentages
      {
        $project: {
          cohort: "$_id",
          customers: 1,
          months: {
            $map: {
              input: { $range: [0, 13] },
              as: "m",
              in: {
                $let: {
                  vars: {
                    count: {
                      $size: {
                        $filter: {
                          input: "$monthArrays",
                          cond: { $in: ["$$m", "$$this"] },
                          as: "this"
                        }
                      }
                    }
                  },
                  in: {
                    $concat: [
                      {
                        $toString: {
                          $round: [
                            { $multiply: [{ $divide: ["$$count", "$customers"] }, 100] },
                            1
                          ]
                        }
                      },
                      "%"
                    ]
                  }
                }
              }
            }
          },
          retentionRate: {       // ⭐ MONTH-1 RETENTION RATE
            $concat: [
              {
                $toString: {
                  $round: [
                    {
                      $multiply: [
                        {
                          $divide: [
                            {
                              $size: {
                                $filter: {
                                  input: "$monthArrays",
                                  as: "arr",
                                  cond: { $in: [1, "$$arr"] }
                                }
                              }
                            },
                            "$customers"
                          ]
                        },
                        100
                      ]
                    },
                    1
                  ]
                }
              },
              "%"
            ]
          }
        }
      },

      // sort by real date, not string
      {
        $sort: {
          cohort: 1
        }
      }
    ]);

    res.json({ cohorts: agg });
  } catch (err) {
    console.error("FAST COHORT ERROR:", err);
    res.status(500).json({ error: "Failed to compute cohort analysis" });
  }
});
// GET: Delivered revenue per agent
// GET Delivered Revenue Per Agent (with date range + active filter + roles)
router.get("/delivered-sales-per-agent", async (req, res) => {
  try {
    let { start, end } = req.query;

    // If no dates → default last 30 days
    let startDate, endDate;

    if (!start || !end) {
      endDate = new Date();
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
    } else {
      startDate = new Date(`${start}T00:00:00.000Z`);
      endDate = new Date(`${end}T23:59:59.999Z`);
    }

    const agents = await Employee.find({
      status: "active",
      role: { $in: ["Sales Agent", "Retention Agent"] },
      totalDeliveredSales: { $gt: 0 }
    })
      .select("fullName totalDeliveredSales")
      .lean();

    agents.sort((a, b) => (b.totalDeliveredSales || 0) - (a.totalDeliveredSales || 0));

    return res.json({ agents });
  } catch (err) {
    console.error("DELIVERED SALES ERROR:", err);
    res.status(500).json({ error: "Failed to load delivered sales" });
  }
});
// GET: COD Delivered Count + Amount
router.get("/cod-delivered", async (req, res) => {
  try {
    let { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const s = new Date(start);
    const e = new Date(end);
    e.setHours(23, 59, 59);

    // 1️⃣ Delivered orders from Order schema
    const deliveredOrders = await Order.find(
      {
        shipment_status: "Delivered",
        order_date: { $gte: s, $lte: e }
      },
      { order_id: 1 }
    ).lean();

    const orderNames = deliveredOrders.map((o) => o.order_id).filter(Boolean);

    if (!orderNames.length) {
      return res.json({ totalCount: 0, totalAmount: 0, orders: [] });
    }

    // 2️⃣ Match Shopify Orders using orderName
    const shopifyMatches = await ShopifyOrder.find(
      {
        orderName: { $in: orderNames },
        modeOfPayment: { $regex: /cod/i }   // FIXED HERE 🎉
      },
      { amount: 1, orderName: 1 }
    ).lean();

    const totalCount = shopifyMatches.length;
    const totalAmount = shopifyMatches.reduce((sum, o) => sum + (o.amount || 0), 0);

    return res.json({
      totalCount,
      totalAmount,
      orders: shopifyMatches
    });

  } catch (err) {
    console.error("COD DELIVERED ERROR:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});







// ------------------------------
// ⚡ In-memory cache for speed
// ------------------------------
const aovCache = new Map();

function aovCacheGet(key) {
  const entry = aovCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    aovCache.delete(key);
    return null;
  }
  return entry.data;
}

function aovCacheSet(key, data, ttl = 30000) {
  aovCache.set(key, { data, expires: Date.now() + ttl });
}


// ============================================
// BACKEND: FINAL FIXED /aov-over-time endpoint
// File: routes/superAdminAnalytics.js
// ============================================

router.get("/aov-over-time", async (req, res) => {
  try {
    let {
      start,
      end,
      scope = "combined",
      compareMode = "none",
      customCompareStart,
      customCompareEnd,
    } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    // 🔥 CACHE KEY
    const cacheKey = `aov_${start}_${end}_${scope}_${customCompareStart || ""}_${customCompareEnd || ""}`;
    const cached = aovCacheGet(cacheKey);
    if (cached) return res.json(cached);

    scope = scope.toLowerCase();

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const MS_PER_HOUR = 60 * 60 * 1000;

    const parseStart = (d) => new Date(`${d}T00:00:00.000Z`);
    const parseEnd = (d) => new Date(`${d}T23:59:59.999Z`);

    const baseStart = parseStart(start);
    const baseEnd = parseEnd(end);
    const dayCount = Math.floor((baseEnd - baseStart) / MS_PER_DAY) + 1;

    const isSingleDay = start === end;

    // CHANNEL FILTERS
    const ONLINE = CHANNEL_MAP["Online Order"];
    const TEAM = CHANNEL_MAP.Team;

    const buildMatch = (from, to) => {
      const m = {
        shopifyCreatedAt: { $gte: from, $lte: to },
        amount: { $gt: 0 },
      };

      if (scope === "team") {
        m.$or = [
          { channelName: TEAM },
          { "orderConfirmOps.assignedAgentName": { $exists: true, $ne: "" } },
        ];
      } else if (scope === "online") {
        m.channelName = ONLINE;
        m.$or = [
          { "orderConfirmOps.assignedAgentName": { $exists: false } },
          { "orderConfirmOps.assignedAgentName": "" },
          { "orderConfirmOps.assignedAgentName": null },
        ];
      }

      return m;
    };

    // AGGREGATOR FOR DAILY DATA
    const aggregateAOVDaily = async (from, to) => {
      const match = buildMatch(from, to);

      const docs = await ShopifyOrder.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" },
            },
            totalAmount: { $sum: "$amount" },
            orders: { $sum: 1 },
          },
        },
      ]);

      const perDay = {};
      let total = 0;
      let count = 0;

      docs.forEach((d) => {
        perDay[d._id] = d.orders ? d.totalAmount / d.orders : 0;
        total += d.totalAmount;
        count += d.orders;
      });

      return {
        perDay,
        overallAOV: count ? Number((total / count).toFixed(2)) : 0,
        totalOrders: count,
        totalRevenue: total,
      };
    };

    // AGGREGATOR FOR HOURLY DATA
    const aggregateAOVHourly = async (from, to) => {
      const match = buildMatch(from, to);

      const orders = await ShopifyOrder.aggregate([
        { $match: match },
        {
          $project: {
            shopifyCreatedAt: 1,
            hour: { $hour: "$shopifyCreatedAt" },
            amount: 1,
          },
        },
      ]);

      const hourlyData = {};
      orders.forEach((o) => {
        const hour = o.hour;
        if (!hourlyData[hour]) {
          hourlyData[hour] = { total: 0, count: 0 };
        }
        hourlyData[hour].total += o.amount;
        hourlyData[hour].count += 1;
      });

      const overallAOV = orders.length > 0
        ? Number(
            (
              orders.reduce((s, o) => s + o.amount, 0) / orders.length
            ).toFixed(2)
          )
        : 0;

      return {
        hourlyData,
        overallAOV,
        totalOrders: orders.length,
        totalRevenue: orders.reduce((s, o) => s + o.amount, 0),
      };
    };

    // =======================================
    // NO COMPARISON - Just return current data
    // =======================================
    if (!customCompareStart || !customCompareEnd) {
      if (isSingleDay) {
        const currentData = await aggregateAOVHourly(baseStart, baseEnd);

        const points = [];
        for (let h = 0; h < 24; h++) {
          const hourStr = String(h).padStart(2, "0") + ":00";
          const data = currentData.hourlyData[h];
          const aov = data ? Number((data.total / data.count).toFixed(2)) : 0;

          points.push({
            label: hourStr,
            current: aov,
            previous: 0,
          });
        }

        const response = {
          current: {
            aov: currentData.overallAOV,
            totalOrders: currentData.totalOrders,
            range: { start, end },
          },
          previous: null,
          points,
          isSingleDay: true,
        };

        aovCacheSet(cacheKey, response);
        return res.json(response);
      } else {
        const currentDaily = await aggregateAOVDaily(baseStart, baseEnd);

        const points = [];
        for (let i = 0; i < dayCount; i++) {
          const d = new Date(baseStart.getTime() + i * MS_PER_DAY);
          const key = d.toISOString().slice(0, 10);

          points.push({
            label: key,
            current: currentDaily.perDay[key] || 0,
            previous: 0,
          });
        }

        const response = {
          current: {
            aov: currentDaily.overallAOV,
            totalOrders: currentDaily.totalOrders,
            range: { start, end },
          },
          previous: null,
          points,
          isSingleDay: false,
        };

        aovCacheSet(cacheKey, response);
        return res.json(response);
      }
    }

    // =======================================
    // WITH COMPARISON
    // =======================================
    const compareStart = parseStart(customCompareStart);
    const compareEnd = parseEnd(customCompareEnd);
    const compareIsSingleDay = customCompareStart === customCompareEnd;

    // 🔥 CASE 1: BOTH ARE SINGLE DAYS (06 Dec vs 05 Dec)
    if (isSingleDay && compareIsSingleDay) {
      const currentData = await aggregateAOVHourly(baseStart, baseEnd);
      const comparisonData = await aggregateAOVHourly(compareStart, compareEnd);

      const mergedPoints = [];
      for (let h = 0; h < 24; h++) {
        const hourStr = String(h).padStart(2, "0") + ":00";
        const currentHourData = currentData.hourlyData[h];
        const comparisonHourData = comparisonData.hourlyData[h];

        const currentAOV = currentHourData ? Number((currentHourData.total / currentHourData.count).toFixed(2)) : 0;
        const comparisonAOV = comparisonHourData ? Number((comparisonHourData.total / comparisonHourData.count).toFixed(2)) : 0;

        mergedPoints.push({
          label: hourStr,
          current: currentAOV,
          previous: comparisonAOV,
        });
      }

      const response = {
        current: {
          aov: currentData.overallAOV,
          totalOrders: currentData.totalOrders,
          range: { start, end },
        },
        previous: {
          aov: comparisonData.overallAOV,
          totalOrders: comparisonData.totalOrders,
          range: { start: customCompareStart, end: customCompareEnd },
        },
        points: mergedPoints,
        isSingleDay: true,
      };

      aovCacheSet(cacheKey, response);
      return res.json(response);
    }

    // 🔥 CASE 2: CURRENT IS SINGLE DAY, COMPARISON IS RANGE (06 Dec vs 01-06 Dec)
    if (isSingleDay && !compareIsSingleDay) {
      const currentData = await aggregateAOVHourly(baseStart, baseEnd);
      const comparisonData = await aggregateAOVDaily(compareStart, compareEnd);

      // Create hourly points for comparison by distributing daily AOV equally
      const mergedPoints = [];
      
      // Get average hourly data from comparison period
      const comparisonOrders = await ShopifyOrder.aggregate([
        { $match: buildMatch(compareStart, compareEnd) },
        {
          $project: {
            shopifyCreatedAt: 1,
            hour: { $hour: "$shopifyCreatedAt" },
            amount: 1,
          },
        },
      ]);

      const comparisonHourlyData = {};
      comparisonOrders.forEach((o) => {
        const hour = o.hour;
        if (!comparisonHourlyData[hour]) {
          comparisonHourlyData[hour] = { total: 0, count: 0 };
        }
        comparisonHourlyData[hour].total += o.amount;
        comparisonHourlyData[hour].count += 1;
      });

      // Merge by hour
      for (let h = 0; h < 24; h++) {
        const hourStr = String(h).padStart(2, "0") + ":00";
        const currentHourData = currentData.hourlyData[h];
        const comparisonHourData = comparisonHourlyData[h];

        const currentAOV = currentHourData ? Number((currentHourData.total / currentHourData.count).toFixed(2)) : 0;
        const comparisonAOV = comparisonHourData ? Number((comparisonHourData.total / comparisonHourData.count).toFixed(2)) : 0;

        mergedPoints.push({
          label: hourStr,
          current: currentAOV,
          previous: comparisonAOV,
        });
      }

      const response = {
        current: {
          aov: currentData.overallAOV,
          totalOrders: currentData.totalOrders,
          range: { start, end },
        },
        previous: {
          aov: comparisonData.overallAOV,
          totalOrders: comparisonData.totalOrders,
          range: { start: customCompareStart, end: customCompareEnd },
        },
        points: mergedPoints,
        isSingleDay: true,
      };

      aovCacheSet(cacheKey, response);
      return res.json(response);
    }

    // 🔥 CASE 3: BOTH ARE RANGES (06-10 Dec vs 01-05 Dec)
    if (!isSingleDay && !compareIsSingleDay) {
      const currentDaily = await aggregateAOVDaily(baseStart, baseEnd);
      const compareDayCount = Math.floor((compareEnd - compareStart) / MS_PER_DAY) + 1;
      const previousDaily = await aggregateAOVDaily(compareStart, compareEnd);

      const timeMap = new Map();

      // Add current period
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(baseStart.getTime() + i * MS_PER_DAY);
        const key = d.toISOString().slice(0, 10);
        timeMap.set(key, {
          label: key,
          current: currentDaily.perDay[key] || 0,
          previous: 0,
        });
      }

      // Add comparison period - merge by matching dates
      for (let i = 0; i < compareDayCount; i++) {
        const d = new Date(compareStart.getTime() + i * MS_PER_DAY);
        const key = d.toISOString().slice(0, 10);
        
        if (timeMap.has(key)) {
          timeMap.get(key).previous = previousDaily.perDay[key] || 0;
        } else {
          timeMap.set(key, {
            label: key,
            current: 0,
            previous: previousDaily.perDay[key] || 0,
          });
        }
      }

      const mergedPoints = Array.from(timeMap.values());
      mergedPoints.sort((a, b) => a.label.localeCompare(b.label));

      const response = {
        current: {
          aov: currentDaily.overallAOV,
          totalOrders: currentDaily.totalOrders,
          range: { start, end },
        },
        previous: {
          aov: previousDaily.overallAOV,
          totalOrders: previousDaily.totalOrders,
          range: { start: customCompareStart, end: customCompareEnd },
        },
        points: mergedPoints,
        isSingleDay: false,
      };

      aovCacheSet(cacheKey, response);
      return res.json(response);
    }

    // 🔥 CASE 4: CURRENT IS RANGE, COMPARISON IS SINGLE DAY (01-05 Dec vs 06 Dec)
    if (!isSingleDay && compareIsSingleDay) {
      const currentDaily = await aggregateAOVDaily(baseStart, baseEnd);
      const comparisonData = await aggregateAOVHourly(compareStart, compareEnd);

      // Get hourly data from current period
      const currentOrders = await ShopifyOrder.aggregate([
        { $match: buildMatch(baseStart, baseEnd) },
        {
          $project: {
            shopifyCreatedAt: 1,
            hour: { $hour: "$shopifyCreatedAt" },
            amount: 1,
          },
        },
      ]);

      const currentHourlyData = {};
      currentOrders.forEach((o) => {
        const hour = o.hour;
        if (!currentHourlyData[hour]) {
          currentHourlyData[hour] = { total: 0, count: 0 };
        }
        currentHourlyData[hour].total += o.amount;
        currentHourlyData[hour].count += 1;
      });

      // Merge by hour
      const mergedPoints = [];
      for (let h = 0; h < 24; h++) {
        const hourStr = String(h).padStart(2, "0") + ":00";
        const currentHourData = currentHourlyData[h];
        const comparisonHourData = comparisonData.hourlyData[h];

        const currentAOV = currentHourData ? Number((currentHourData.total / currentHourData.count).toFixed(2)) : 0;
        const comparisonAOV = comparisonHourData ? Number((comparisonHourData.total / comparisonHourData.count).toFixed(2)) : 0;

        mergedPoints.push({
          label: hourStr,
          current: currentAOV,
          previous: comparisonAOV,
        });
      }

      const response = {
        current: {
          aov: currentDaily.overallAOV,
          totalOrders: currentDaily.totalOrders,
          range: { start, end },
        },
        previous: {
          aov: comparisonData.overallAOV,
          totalOrders: comparisonData.totalOrders,
          range: { start: customCompareStart, end: customCompareEnd },
        },
        points: mergedPoints,
        isSingleDay: false,
      };

      aovCacheSet(cacheKey, response);
      return res.json(response);
    }

  } catch (err) {
    console.error("AOV OVER TIME ERROR:", err);
    res.status(500).json({ error: "Failed to compute AOV over time" });
  }
});

// ✅ UPDATED: /orders-vs-fulfilled endpoint - Gets correct fulfilled data
router.get("/orders-vs-fulfilled", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // Total orders in date range
    const totalOrders = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    });

    // ✅ FULFILLED: fulfillment_status = "fulfilled"
    const fulfilled = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      fulfillment_status: "fulfilled"
    });

    // Delivered orders
    const delivered = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      shipment_status: "delivered"
    });

    // RTO orders
    const rto = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      shipment_status: "RTO"
    });

    // Cancelled orders
    const cancelled = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      cancelled_at: { $exists: true, $ne: null }
    });

    console.log(`📊 ORDERS-VS-FULFILLED [${start} to ${end}]:`, {
      totalOrders,
      fulfilled,
      delivered,
      rto,
      cancelled,
      pending: totalOrders - fulfilled - cancelled
    });

    return res.json({
      totalOrders,
      fulfilled,
      delivered,
      rto,
      cancelled,
      pending: totalOrders - fulfilled - cancelled,
      fulfillmentRate: totalOrders > 0 
        ? `${((fulfilled / totalOrders) * 100).toFixed(1)}%` 
        : "0%"
    });

  } catch (err) {
    console.error("FULFILLMENT STATS ERROR:", err);
    res.status(500).json({ error: "Failed to compute fulfillment stats" });
  }
});

// ✅ UPDATED: /debug-fulfilled endpoint - Debug fulfilled data
router.get("/debug-fulfilled", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // Get ALL orders for date range
    const allOrders = await ShopifyOrder.find({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    })
      .select('orderName fulfillment_status shipment_status financial_status cancelled_at')
      .lean();

    console.log(`\n📊 TOTAL ORDERS FOUND: ${allOrders.length}`);

    // Analyze fulfillment_status values
    const analysis = {
      total: allOrders.length,
      byFulfillmentStatus: {},
      fulfilled: 0,
      notFulfilled: 0,
      samples: []
    };

    allOrders.forEach(o => {
      const fs = o.fulfillment_status || 'empty';
      analysis.byFulfillmentStatus[fs] = (analysis.byFulfillmentStatus[fs] || 0) + 1;

      if (o.fulfillment_status === "fulfilled") {
        analysis.fulfilled++;
      } else {
        analysis.notFulfilled++;
      }

      // Sample first 10 orders
      if (analysis.samples.length < 10) {
        analysis.samples.push({
          orderName: o.orderName,
          fulfillment_status: o.fulfillment_status,
          shipment_status: o.shipment_status,
          financial_status: o.financial_status,
          cancelled: !!o.cancelled_at
        });
      }
    });

    console.log('📊 FULFILLMENT ANALYSIS:');
    console.log('By fulfillment_status:', analysis.byFulfillmentStatus);
    console.log('Fulfilled count:', analysis.fulfilled);
    console.log('Not fulfilled count:', analysis.notFulfilled);

    return res.json({
      dateRange: { start, end },
      totalOrders: analysis.total,
      fulfilled: analysis.fulfilled,
      notFulfilled: analysis.notFulfilled,
      byFulfillmentStatus: analysis.byFulfillmentStatus,
      samples: analysis.samples
    });

  } catch (err) {
    console.error("DEBUG FULFILLED ERROR:", err);
    res.status(500).json({ error: "Failed to debug fulfilled" });
  }
});




router.get("/customer-stats", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "Start and end dates required" });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999); // Include full end day

    // 1️⃣ Get all leads with valid phone number
    const leads = await Lead.find(
      { contactNumber: { $exists: true, $ne: "" } },
      { contactNumber: 1, retentionStatus: 1, lastOrderDate: 1, createdAt: 1 }
    ).lean();

    if (!leads.length) {
      return res.json([]);
    }

    // 2️⃣ Unique customers
    const uniqueMap = new Map();
    leads.forEach((l) => {
      uniqueMap.set(l.contactNumber, l);
    });
    const uniqueCustomers = [...uniqueMap.values()];

    // 3️⃣ Generate date points (daily or weekly based on range)
    const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    const interval = daysDiff > 90 ? 7 : 1; // Weekly if > 90 days, else daily

    const trends = [];
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const pointDate = new Date(currentDate);
      const cutoffDate = new Date(pointDate);
      cutoffDate.setDate(cutoffDate.getDate() - 60); // 60 days active window

      // Count customers at this point in time
      let total = 0;
      let active = 0;
      let lost = 0;

      uniqueCustomers.forEach((cust) => {
        // Only count if customer was created before or on this date
        const customerCreated = cust.createdAt ? new Date(cust.createdAt) : new Date(0);
        if (customerCreated > pointDate) {
          return; // Skip customers not yet created at this point
        }

        total++;

        const status = (cust.retentionStatus || "").toUpperCase();
        const lastOrder = cust.lastOrderDate ? new Date(cust.lastOrderDate) : null;

        // Active: not marked lost AND ordered within 60 days before this point
        const isActive =
          status !== "LOST" &&
          lastOrder &&
          lastOrder >= cutoffDate &&
          lastOrder <= pointDate;

        // Lost: marked lost OR last order was before 60-day window
        const isLost =
          status === "LOST" ||
          (lastOrder && lastOrder < cutoffDate && lastOrder <= pointDate);

        if (isActive) active++;
        else if (isLost) lost++;
      });

      trends.push({
        date: pointDate.toISOString().split('T')[0],
        total,
        active,
        lost,
      });

      // Move to next interval
      currentDate.setDate(currentDate.getDate() + interval);
    }

    return res.json(trends);

  } catch (err) {
    console.error("CUSTOMER TRENDS ERROR:", err);
    res.status(500).json({ error: "Failed to load customer trends" });
  }
});


// ------------------------------
// ⚡ FAST CUSTOMER TRENDS
// ------------------------------
router.get("/customer-trends", async (req, res) => {
  try {
    let { start, end, compareStart, compareEnd } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "dates required" });
    }

    const cacheKey = `cust_trends_${start}_${end}_${compareStart || ""}_${compareEnd || ""}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);
    const isSingle  = start === end;

    // Load all orders in CURRENT period
    const orders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
      { normalizedPhone: 1, shopifyCreatedAt: 1 }
    ).lean();

    // Load all EARLIER orders
    const earlyOrders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $lt: startDate } },
      { normalizedPhone: 1 }
    ).lean();

    const oldCustomers = new Set(earlyOrders.map(o => o.normalizedPhone));

    const activeCount = await Lead.countDocuments({ retentionStatus: /active/i });
    const lostCount   = await Lead.countDocuments({ retentionStatus: /lost/i });

    // ===========================
    // CURRENT PERIOD DATA
    // ===========================
    let currentTrends = [];

    if (isSingle) {
      const map = {};
      orders.forEach(o => {
        const hr = new Date(o.shopifyCreatedAt).getUTCHours();
        if (!map[hr]) map[hr] = { newCustomers: 0 };
        const phone = o.normalizedPhone;
        if (!oldCustomers.has(phone)) {
          map[hr].newCustomers++;
        }
      });

      currentTrends = Object.keys(map).map(h => ({
        date: `${h.padStart(2, "0")}:00`,
        newCustomers: map[h].newCustomers,
        active: activeCount,
        lost: lostCount
      }));
    } else {
      const days = {};
      const MS = 86400000;
      const totalDays = Math.ceil((endDate - startDate) / MS);

      orders.forEach(o => {
        const d = o.shopifyCreatedAt.toISOString().slice(0, 10);
        if (!days[d]) days[d] = [];
        days[d].push(o.normalizedPhone);
      });

      let cur = new Date(startDate);
      for (let i = 0; i <= totalDays; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        const phones = days[dStr] || [];
        let newCustomerCount = 0;

        phones.forEach(phone => {
          if (!oldCustomers.has(phone)) {
            newCustomerCount++;
          }
        });

        currentTrends.push({
          date: dStr,
          newCustomers: newCustomerCount,
          active: activeCount,
          lost: lostCount
        });

        cur = new Date(cur.getTime() + MS);
      }
    }

    // ===========================
    // COMPARISON PERIOD DATA
    // ===========================
    if (!compareStart || !compareEnd) {
      setCache(cacheKey, currentTrends);
      return res.json(currentTrends);
    }

    const compareStartDate = new Date(`${compareStart}T00:00:00.000Z`);
    const compareEndDate   = new Date(`${compareEnd}T23:59:59.999Z`);

    const compareOrders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $gte: compareStartDate, $lte: compareEndDate } },
      { normalizedPhone: 1, shopifyCreatedAt: 1 }
    ).lean();

    const compareEarlyOrders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $lt: compareStartDate } },
      { normalizedPhone: 1 }
    ).lean();

    const compareOldCustomers = new Set(compareEarlyOrders.map(o => o.normalizedPhone));

    let compareTrends = [];

    if (isSingle) {
      const map = {};
      compareOrders.forEach(o => {
        const hr = new Date(o.shopifyCreatedAt).getUTCHours();
        if (!map[hr]) map[hr] = { newCustomers: 0 };
        const phone = o.normalizedPhone;
        if (!compareOldCustomers.has(phone)) {
          map[hr].newCustomers++;
        }
      });

      compareTrends = Object.keys(map).map(h => ({
        date: `${h.padStart(2, "0")}:00`,
        compareNewCustomers: map[h].newCustomers
      }));
    } else {
      const days = {};
      const MS = 86400000;
      const totalDays = Math.ceil((compareEndDate - compareStartDate) / MS);

      compareOrders.forEach(o => {
        const d = o.shopifyCreatedAt.toISOString().slice(0, 10);
        if (!days[d]) days[d] = [];
        days[d].push(o.normalizedPhone);
      });

      let cur = new Date(compareStartDate);
      for (let i = 0; i <= totalDays; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        const phones = days[dStr] || [];
        let newCustomerCount = 0;

        phones.forEach(phone => {
          if (!compareOldCustomers.has(phone)) {
            newCustomerCount++;
          }
        });

        compareTrends.push({
          date: dStr,
          compareNewCustomers: newCustomerCount
        });

        cur = new Date(cur.getTime() + MS);
      }
    }

    // MERGE both periods
    const timeMap = new Map();
    
    currentTrends.forEach(t => {
      timeMap.set(t.date, { ...t });
    });

    compareTrends.forEach(t => {
      if (timeMap.has(t.date)) {
        timeMap.get(t.date).compareNewCustomers = t.compareNewCustomers;
      } else {
        timeMap.set(t.date, { date: t.date, newCustomers: 0, compareNewCustomers: t.compareNewCustomers, active: activeCount, lost: lostCount });
      }
    });

    const mergedTrends = Array.from(timeMap.values());
    mergedTrends.sort((a, b) => a.date.localeCompare(b.date));

    setCache(cacheKey, mergedTrends);
    return res.json(mergedTrends);

  } catch (err) {
    console.error("FAST CUSTOMER TRENDS ERROR:", err);
    return res.status(500).json({ error: "Failed to load fast trends" });
  }
});


router.get("/payment-mode-stats", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    // 🔥 CACHE
    const cacheKey = `payment_${start}_${end}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    // ✅ Use financial_status as single source of truth
    const orders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
      { amount: 1, financial_status: 1 }
    ).lean();

    let codCount = 0,
      codAmount = 0,
      prepaidCount = 0,
      prepaidAmount = 0;

    const isPrepaid = (fs) =>
      String(fs || "").toLowerCase() === "paid";

    orders.forEach((o) => {
      const amt = o.amount || 0;

      if (isPrepaid(o.financial_status)) {
        // PREPAID = financial_status === "paid"
        prepaidCount++;
        prepaidAmount += amt;
      } else {
        // everything else = COD
        codCount++;
        codAmount += amt;
      }
    });

    const totalOrders = orders.length;
    const safeTotal = totalOrders || 1; // avoid divide-by-zero

    const response = {
      dateRange: { start, end },
      totalOrders,
      cod: {
        count: codCount,
        amount: codAmount,
        percentage: `${((codCount / safeTotal) * 100).toFixed(1)}%`,
      },
      prepaid: {
        count: prepaidCount,
        amount: prepaidAmount,
        percentage: `${((prepaidCount / safeTotal) * 100).toFixed(1)}%`,
      },
    };

    // 🔥 SAVE TO CACHE
    setCache(cacheKey, response);

    return res.json(response);
  } catch (err) {
    console.error("PAYMENT MODE STATS ERROR:", err);
    return res
      .status(500)
      .json({ error: "Failed to compute payment stats" });
  }
});


// -----------------------------
// 📌 DATE-WISE TOTAL SALES
// -----------------------------
router.get("/sales-per-day", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    const results = await ShopifyOrder.aggregate([
      {
        $match: {
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          amount: { $gt: 0 }  // only paid orders
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" }
          },
          totalSales: { $sum: "$amount" },
          orders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } } // ascending by date
    ]);

    // Format output
    const formatted = results.map(r => ({
      date: r._id,
      totalSales: r.totalSales,
      orders: r.orders
    }));

    res.json(formatted);

  } catch (err) {
    console.error("SALES PER DAY ERROR:", err);
    res.status(500).json({ error: "Failed to compute daily sales" });
  }
});
router.get("/orders-over-time", async (req, res) => {
  try {
    let { start, end, filter = "all", compareStart, compareEnd } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "Start & End required" });
    }

    const cacheKey = `ordersTime_${start}_${end}_${filter}_${compareStart || ""}_${compareEnd || ""}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);

    const isSingleDay = start === end;

    // 🔥 FIXED FILTER
    let paymentMatch = {};
    if (filter === "cod") {
      paymentMatch = { financial_status: { $ne: "paid" } };
    } 
    else if (filter === "prepaid") {
      paymentMatch = { financial_status: "paid" };
    }

    // ===============================================
    // CURRENT PERIOD
    // ===============================================
    const pipeline = [
      { 
        $match: { 
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          ...paymentMatch
        }
      },
      {
        $group: {
          _id: isSingleDay 
            ? { hour: { $hour: "$shopifyCreatedAt" } }
            : { date: { $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" } } },
          orders: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ];

    const currentResult = await ShopifyOrder.aggregate(pipeline);

    const currentTrend = currentResult.map((r) =>
      isSingleDay
        ? {
            time: String(r._id.hour).padStart(2, "0") + ":00",
            current: r.orders,
            previous: 0
          }
        : {
            time: r._id.date,
            current: r.orders,
            previous: 0
          }
    );

    const currentTotal = currentTrend.reduce((s, t) => s + t.current, 0);

    // ===============================================
    // COMPARISON PERIOD (if provided)
    // ===============================================
    let comparisonTrend = [];
    let comparisonTotal = 0;

    if (compareStart && compareEnd) {
      const compareStartDate = new Date(`${compareStart}T00:00:00.000Z`);
      const compareEndDate   = new Date(`${compareEnd}T23:59:59.999Z`);

      const comparePipeline = [
        { 
          $match: { 
            shopifyCreatedAt: { $gte: compareStartDate, $lte: compareEndDate },
            ...paymentMatch
          }
        },
        {
          $group: {
            _id: isSingleDay 
              ? { hour: { $hour: "$shopifyCreatedAt" } }
              : { date: { $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" } } },
            orders: { $sum: 1 }
          }
        },
        { $sort: { "_id": 1 } }
      ];

      const compareResult = await ShopifyOrder.aggregate(comparePipeline);

      comparisonTrend = compareResult.map((r) =>
        isSingleDay
          ? {
              time: String(r._id.hour).padStart(2, "0") + ":00",
              previous: r.orders
            }
          : {
              time: r._id.date,
              previous: r.orders
            }
      );

      comparisonTotal = comparisonTrend.reduce((s, t) => s + t.previous, 0);

      // MERGE both trends (current + comparison)
      const mergedTrend = [];
      const timeMap = new Map();

      currentTrend.forEach(t => {
        timeMap.set(t.time, { ...t });
      });

      comparisonTrend.forEach(t => {
        if (timeMap.has(t.time)) {
          timeMap.get(t.time).previous = t.previous;
        } else {
          timeMap.set(t.time, { time: t.time, current: 0, previous: t.previous });
        }
      });

      timeMap.forEach(t => mergedTrend.push(t));
      mergedTrend.sort((a, b) => a.time.localeCompare(b.time));

      const response = { 
        total: currentTotal,
        comparison: {
          total: comparisonTotal,
          start: compareStart,
          end: compareEnd
        },
        trend: mergedTrend,
        isSingleDay,
        hasComparison: true
      };

      setCache(cacheKey, response);
      return res.json(response);
    }

    const response = { 
      total: currentTotal, 
      trend: currentTrend, 
      isSingleDay,
      hasComparison: false
    };

    setCache(cacheKey, response);
    return res.json(response);

  } catch (err) {
    console.error("ORDER TREND ERROR:", err);
    return res.status(500).json({ error: "Failed to compute order trend" });
  }
});



router.get("/dashboard-summary", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    // 30 sec cache
    const cacheKey = `summary_${start}_${end}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // 1️⃣ FETCH ONLY REQUIRED FIELDS (SUPER FAST)
    const orders = await ShopifyOrder.find(
      { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
      { amount: 1, financial_status: 1 }
    ).lean();

    let totalSales = 0;
    let totalOrders = orders.length;

    let prepaidCount = 0, codCount = 0;
    let prepaidAmount = 0, codAmount = 0;

    orders.forEach(o => {
      const amt = o.amount || 0;
      totalSales += amt;

      if (o.financial_status === "paid") {
        prepaidCount++;
        prepaidAmount += amt;
      } else {
        codCount++;
        codAmount += amt;
      }
    });

    const aov = totalOrders ? Number((totalSales / totalOrders).toFixed(2)) : 0;

    const response = {
      totalSales,
      totalOrders,
      aov,
      prepaid: {
        count: prepaidCount,
        amount: prepaidAmount,
        percentage: totalOrders
          ? Number(((prepaidCount / totalOrders) * 100).toFixed(1))
          : 0,
      },
      cod: {
        count: codCount,
        amount: codAmount,
        percentage: totalOrders
          ? Number(((codCount / totalOrders) * 100).toFixed(1))
          : 0,
      }
    };

    // CACHE RESULT
    setCache(cacheKey, response, 30000); // 30s

    res.json(response);

  } catch (err) {
    console.error("SUMMARY ERROR:", err);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

module.exports = router;  
