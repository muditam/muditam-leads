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

  function setCache(key, data, ttlMs = 30000) { // 30 sec cache
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
  function monthDiff(from, to) {
  return (
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth())
  );
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

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    // Get order IDs from ShopifyOrder in date range
    const shopifyOrderIds = await ShopifyOrder.aggregate([
      {
        $match: {
          $or: [
            { orderDate: { $gte: startDate, $lte: endDate } },
            { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
          ],
        }
      },
      {
        $project: {
          orderKey: {
            $replaceAll: {
              input: { $ifNull: ["$orderName", ""] },
              find: "#",
              replacement: "",
            }
          }
        }
      }
    ]);

    const orderKeys = shopifyOrderIds.map(o => o.orderKey).filter(Boolean);

    // Count delivered from Order.js (exclude RTO Delivered)
    const delivered = await Order.countDocuments({
      order_id: { $in: orderKeys },
      shipment_status: {
        $regex: /^delivered$/i,
        $not: /rto/i
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

      return res.json({ delivered });
    } catch (err) {
      console.error("Delivered analytics error:", err);
      res.status(500).json({ error: "Failed to fetch delivered count" });
    }
  });

router.get("/aov", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);

    const ONLINE_ID = "252664381441";
    const TEAM_ID = "205650526209";
 

    // Single aggregation to get all AOV stats
    const [result] = await ShopifyOrder.aggregate([
      {
        $match: {
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          amount: { $gt: 0 },
        }
      },
      {
        $addFields: {
          isTeam: {
            $or: [
              { $eq: ["$channelName", TEAM_ID] },
              { $and: [
                { $ne: [{ $ifNull: ["$orderConfirmOps.assignedAgentName", ""] }, ""] },
                { $ne: ["$orderConfirmOps.assignedAgentName", null] }
              ]}
            ]
          },
          isOnline: {
            $and: [
              { $eq: ["$channelName", ONLINE_ID] },
              {
                $or: [
                  { $eq: [{ $ifNull: ["$orderConfirmOps.assignedAgentName", ""] }, ""] },
                  { $eq: ["$orderConfirmOps.assignedAgentName", null] }
                ]
              }
            ]
          }
        }
      },
      {
        $facet: {
          online: [
            { $match: { isOnline: true } },
            { $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 }
            }}
          ],
          team: [
            { $match: { isTeam: true } },
            { $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 }
            }}
          ],
          combined: [
            { $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 }
            }}
          ]
        }
      }
    ]).allowDiskUse(true);

    const calcAOV = (arr) => {
      if (!arr || arr.length === 0 || !arr[0]) return { aov: 0, orders: 0 };
      const { totalAmount, count } = arr[0];
      return {
        aov: count ? Math.round(totalAmount / count) : 0,
        orders: count
      };
    };

    const response = {
      online: calcAOV(result.online),
      team: calcAOV(result.team),
      combined: calcAOV(result.combined),
    }; 

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

    const OPEN_STATUSES = ["Open", "In Progress"];

    const open = await Escalation.countDocuments({
      status: { $in: OPEN_STATUSES },
      createdAt: { $gte: startDate, $lte: endDate }
    });

    const closed = await Escalation.countDocuments({
      status: "Closed",
      createdAt: { $gte: startDate, $lte: endDate }
    });

    return res.json({ open, closed });

  } catch (err) {
    console.error("ESCALATION ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch escalation stats" });
  }
});


  router.get("/diet-plans", async (req, res) => {
    try {
      const { start, end } = req.query;

      if (!start || !end) {
        return res.status(400).json({ error: "start & end required" });
      }

      const startDate = new Date(`${start}T00:00:00.000Z`);
      const endDate = new Date(`${end}T23:59:59.999Z`);

      const count = await DietPlan.countDocuments({
        createdAt: { $gte: startDate, $lte: endDate }
      });

      return res.json({ totalDietPlans: count });

    } catch (err) {
      console.error("DIET PLAN COUNT ERROR:", err);
      res.status(500).json({ error: "Failed to fetch diet plan count" });
    }
  });

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

  router.get("/cod-delivered", async (req, res) => {
    try {
      let { start, end } = req.query;

      if (!start || !end) {
        return res.status(400).json({ error: "start and end required" });
      }

      const s = new Date(start);
      const e = new Date(end);
      e.setHours(23, 59, 59);

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

      const shopifyMatches = await ShopifyOrder.find(
        {
          orderName: { $in: orderNames },
          modeOfPayment: { $regex: /cod/i }  
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

router.get("/aov-over-time", async (req, res) => {
  try {
    let {
      start,
      end,
      scope = "combined",
      customCompareStart,
      customCompareEnd
    } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "Start & End required" });
    }

    const parseStart = (d) => new Date(`${d}T00:00:00.000Z`);
    const parseEnd = (d) => new Date(`${d}T23:59:59.999Z`);

    const startDate = parseStart(start);
    const endDate = parseEnd(end);
    const isSingleDay = start === end;

    const MS_DAY = 24 * 60 * 60 * 1000;

    // CHANNEL FILTER
    const ONLINE = CHANNEL_MAP["Online Order"];
    const TEAM = CHANNEL_MAP.Team;

    const buildMatch = (from, to) => {
      const m = {
        shopifyCreatedAt: { $gte: from, $lte: to },
        amount: { $gt: 0 }
      };

      if (scope === "team") {
        m.$or = [
          { channelName: TEAM },
          { "orderConfirmOps.assignedAgentName": { $exists: true, $ne: "" } }
        ];
      } else if (scope === "online") {
        m.channelName = ONLINE;
        m.$or = [
          { "orderConfirmOps.assignedAgentName": { $exists: false } },
          { "orderConfirmOps.assignedAgentName": "" },
          { "orderConfirmOps.assignedAgentName": null }
        ];
      }

      return m;
    };


    const aggregateHourly = async (from, to) => {
      const match = buildMatch(from, to);

      const docs = await ShopifyOrder.aggregate([
        { $match: match },
        {
          $project: {
            hour: { $hour: "$shopifyCreatedAt" },
            amount: 1
          }
        }
      ]);

      const hourly = {};
      let totalAmount = 0;
      let totalOrders = 0;

      docs.forEach(d => {
        hourly[d.hour] = hourly[d.hour] || { total: 0, count: 0 };
        hourly[d.hour].total += d.amount;
        hourly[d.hour].count += 1;

        totalAmount += d.amount;
        totalOrders += 1;
      });

      const overallAOV = totalOrders ? Number((totalAmount / totalOrders).toFixed(2)) : 0;

      return { hourly, overallAOV, totalOrders };
    };

   
    const aggregateDaily = async (from, to) => {
      const match = buildMatch(from, to);

      const docs = await ShopifyOrder.aggregate([
        { $match: match },
        {
          $group: {
            _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" } } },
            totalAmount: { $sum: "$amount" },
            orders: { $sum: 1 }
          }
        },
        { $sort: { "_id.date": 1 } }
      ]);

      let map = {};
      let totalAmount = 0;
      let totalOrders = 0;

      docs.forEach(d => {
        map[d._id.date] = d.orders ? d.totalAmount / d.orders : 0;
        totalAmount += d.totalAmount;
        totalOrders += d.orders;
      });

      const overallAOV = totalOrders ? Number((totalAmount / totalOrders).toFixed(2)) : 0;

      return { map, overallAOV, totalOrders };
    };
 
    if (!customCompareStart || !customCompareEnd) {
       if (isSingleDay) {
        const data = await aggregateHourly(startDate, endDate);

        const points = Array.from({ length: 24 }, (_, h) => {
          const d = data.hourly[h];
          const aov = d ? Number((d.total / d.count).toFixed(2)) : 0;

          return {
            label: `${String(h).padStart(2, "0")}:00`,
            current: aov,
            previous: 0
          };
        });

        return res.json({
          current: {
            aov: data.overallAOV,
            totalOrders: data.totalOrders,
            range: { start, end }
          },
          previous: null,
          points,
          isSingleDay: true
        });
      }
 
      const data = await aggregateDaily(startDate, endDate);

      const points = [];
      let cursor = new Date(startDate);

      while (cursor <= endDate) {
        const key = cursor.toISOString().slice(0, 10);
        points.push({
          label: key,
          current: data.map[key] || 0,
          previous: 0
        });

        cursor = new Date(cursor.getTime() + MS_DAY);
      }

      return res.json({
        current: {
          aov: data.overallAOV,
          totalOrders: data.totalOrders,
          range: { start, end }
        },
        previous: null,
        points,
        isSingleDay: false
      });
    }
 
    const currentStart = parseStart(end);     
    const currentEnd = parseEnd(end);

    const compareStartDate = parseStart(customCompareStart);  
    const compareEndDate = parseEnd(customCompareStart);

    const curr = await aggregateHourly(currentStart, currentEnd);
    const prev = await aggregateHourly(compareStartDate, compareEndDate);

    const merged = Array.from({ length: 24 }, (_, h) => {
      const c = curr.hourly[h];
      const p = prev.hourly[h];

      const currAOV = c ? Number((c.total / c.count).toFixed(2)) : 0;
      const prevAOV = p ? Number((p.total / p.count).toFixed(2)) : 0;

      return {
        label: `${String(h).padStart(2, "0")}:00`,
        current: currAOV,
        previous: prevAOV
      };
    });

  return res.json({
  current: {
    aov: curr.overallAOV,
    totalOrders: curr.totalOrders,
    range: { start: end, end: end }
  },
  previous: {
    aov: prev.overallAOV,
    totalOrders: prev.totalOrders,
    range: { start: customCompareStart, end: customCompareStart }
  },
  points: merged,
  isSingleDay: true
});


  } catch (err) {
    console.error("AOV OVER TIME ERROR:", err);
    res.status(500).json({ error: "Failed to compute AOV over time" });
  }
});



router.get("/rto", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);
 
    const shopifyOrderIds = await ShopifyOrder.aggregate([
      {
        $match: {
          $or: [
            { orderDate: { $gte: startDate, $lte: endDate } },
            { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
          ],
        }
      },
      {
        $project: {
          orderKey: {
            $replaceAll: {
              input: { $ifNull: ["$orderName", ""] },
              find: "#",
              replacement: "",
            }
          }
        }
      }
    ]);

    const orderKeys = shopifyOrderIds.map(o => o.orderKey).filter(Boolean);
 
    const [rtoStats] = await Order.aggregate([
      {
        $match: {
          order_id: { $in: orderKeys }
        }
      },
      {
        $addFields: {
          statusLower: { $toLower: { $trim: { input: { $ifNull: ["$shipment_status", ""] } } } }
        }
      },
      {
        $group: {
          _id: null,
          rto: {
            $sum: {
              $cond: [
                { $and: [
                  { $regexMatch: { input: "$statusLower", regex: /^rto$/i } }
                ]},
                1,
                0
              ]
            }
          },
          rtoDelivered: {
            $sum: {
              $cond: [
                { $regexMatch: { input: "$statusLower", regex: /rto delivered/i } },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const rtoOnly = rtoStats?.rto || 0;
    const rtoDelivered = rtoStats?.rtoDelivered || 0;
    const totalRto = rtoOnly + rtoDelivered;

    return res.json({
      dateRange: { start, end },
      rto: rtoOnly,
      rtoDelivered,
      totalRto
    });

  } catch (err) {
    console.error("RTO ERROR:", err);
    return res.status(500).json({ 
      error: "Failed to fetch RTO analytics",
      details: err.message 
    });
  }
});


router.get("/find-status-values", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);
 
    const fulfillmentValues = await ShopifyOrder.aggregate([
      {
        $match: {
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          fulfillment_status: { $exists: true }
        }
      },
      {
        $group: {
          _id: "$fulfillment_status",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);
 
    const shipmentValues = await ShopifyOrder.aggregate([
      {
        $match: {
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          shipment_status: { $exists: true }
        }
      },
      {
        $group: {
          _id: "$shipment_status",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const samples = await ShopifyOrder.find({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    })
      .select('orderName fulfillment_status shipment_status cancelled_at')
      .limit(5)
      .lean();
 
    fulfillmentValues.forEach(v => { 
    });
 
    shipmentValues.forEach(v => { 
    });
 
    samples.forEach((o, i) => { 
    });

    return res.json({
      dateRange: { start, end },
      fulfillmentStatusValues: fulfillmentValues,
      shipmentStatusValues: shipmentValues,
      sampleOrders: samples,
      message: "Check server console for detailed output"
    });

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: "Failed", details: err.message });
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

      const uniqueMap = new Map();
      leads.forEach((l) => {
        uniqueMap.set(l.contactNumber, l);
      });
      const uniqueCustomers = [...uniqueMap.values()];

      const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
      const interval = daysDiff > 90 ? 7 : 1; 

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
          const customerCreated = cust.createdAt ? new Date(cust.createdAt) : new Date(0);
          if (customerCreated > pointDate) {
            return;       }
          total++;
          const status = (cust.retentionStatus || "").toUpperCase();
          const lastOrder = cust.lastOrderDate ? new Date(cust.lastOrderDate) : null;

          const isActive =
            status !== "LOST" &&
            lastOrder &&
            lastOrder >= cutoffDate &&
            lastOrder <= pointDate;

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

        currentDate.setDate(currentDate.getDate() + interval);
      }

      return res.json(trends);

    } catch (err) {
      console.error("CUSTOMER TRENDS ERROR:", err);
      res.status(500).json({ error: "Failed to load customer trends" });
    }
  });

const cohortCache = new Map();

function getCohortCache(key) {
  const entry = cohortCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cohortCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCohortCache(key, data, ttl = 600000) {
  cohortCache.set(key, { data, expires: Date.now() + ttl });
}

function getDurationInMonths(product) {
  if (!product || !product.month) return 1;
  const raw = String(product.month).trim().toLowerCase();
  const num = parseInt(raw.replace(/\D/g, ""), 10);
  if (!num) return 1;

  if (raw.includes("day")) return Math.max(1, Math.ceil(num / 30));
  if (raw.includes("month")) return num;
  return num;
}

router.get("/cohort-analysis", async (req, res) => {
  try {
    const { start, end } = req.query;
    const DEFAULT_MONTHS = 12; // 🔥 CHANGED: 12 months (M0-M11)

    const now = new Date();
    const END_LIMIT = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const defaultStart = new Date(
      Date.UTC(now.getFullYear(), now.getMonth() - 11, 1)
    );

    const startDate = start
      ? new Date(`${start}T00:00:00.000Z`)
      : defaultStart;

    const endDate = end
      ? new Date(`${end}T23:59:59.999Z`)
      : END_LIMIT;

    const cacheKey = `COHORT_${startDate
      .toISOString()
      .slice(0, 10)}_${endDate.toISOString().slice(0, 10)}`;

    const cached = getCohortCache(cacheKey);
    if (cached) return res.json(cached); 

    /* ======================================================
       STEP 1 — FIRST ORDER PER CUSTOMER
    ====================================================== */
    const firstOrders = await ShopifyOrder.aggregate(
      [
        {
          $match: {
            normalizedPhone: { $exists: true, $ne: "" },
            orderDate: { $ne: null },
          },
        },
        {
          $group: {
            _id: "$normalizedPhone",
            firstOrder: { $min: "$orderDate" },
          },
        },
        {
          $project: {
            _id: 1,
            firstOrder: 1,
            cohortKey: {
              $dateToString: { format: "%Y-%m", date: "$firstOrder" },
            },
          },
        },
        {
          $match: {
            firstOrder: { $gte: startDate, $lte: endDate },
          },
        },
      ],
      { allowDiskUse: true }
    );

    if (!firstOrders.length) {
      setCohortCache(cacheKey, { cohorts: [] });
      return res.json({ cohorts: [] });
    } 

    const phoneList = firstOrders.map((c) => c._id);
    const firstOrderMap = new Map(firstOrders.map((c) => [c._id, c]));

    /* ======================================================
       STEP 2 — LOAD ALL ORDERS
    ====================================================== */
    const orders = await ShopifyOrder.find(
      { normalizedPhone: { $in: phoneList } },
      {
        normalizedPhone: 1,
        orderDate: 1,
        amount: 1,
        productsOrdered: 1,
      }
    ).lean();

    /* ======================================================
       STEP 3 — BUILD COHORT STRUCTURE
    ====================================================== */
    const cohortMap = new Map();

    for (const { cohortKey } of firstOrders) {
      if (!cohortMap.has(cohortKey)) {
        cohortMap.set(cohortKey, {
          totalCustomers: 0,
          months: Array(DEFAULT_MONTHS)
            .fill(null)
            .map(() => ({
              total_sales: 0,
              customers: 0,
              aov: 0,
              retention: 0,
              _unique: new Set(),
              _retain: new Set(),
            })),
        });
      }
    }

    for (const c of firstOrders) {
      cohortMap.get(c.cohortKey).totalCustomers++;
    }

    /* ======================================================
       STEP 4 — ASSIGN ORDERS (🔥 FIXED LOGIC)
       
       KEY CHANGE:
       - Cohort month = EXCLUDED
       - M0 = NEXT month after cohort
       - M11 = 12 months after cohort
       
       Example for Jan 2025 cohort:
       - Jan 2025 order → monthDiff=0 → monthIndex=-1 → SKIPPED ✅
       - Feb 2025 order → monthDiff=1 → monthIndex=0 → M0 ✅
       - Mar 2025 order → monthDiff=2 → monthIndex=1 → M1 ✅
       - Jan 2026 order → monthDiff=12 → monthIndex=11 → M11 ✅
    ====================================================== */
    for (const order of orders) {
      const firstInfo = firstOrderMap.get(order.normalizedPhone);
      if (!firstInfo) continue;

      const firstOrderDate = new Date(firstInfo.firstOrder);
      const orderDate = new Date(order.orderDate);

      // Calculate month difference
      const cohortYear = firstOrderDate.getFullYear();
      const cohortMonth = firstOrderDate.getMonth();
      
      const orderYear = orderDate.getFullYear();
      const orderMonth = orderDate.getMonth();

      const monthDiff = (orderYear - cohortYear) * 12 + (orderMonth - cohortMonth);

      // 🔥 KEY FIX: Shift by -1 to exclude cohort month
      const monthIndex = monthDiff - 1;

      // Skip if in cohort month (monthIndex < 0) or beyond M11
      if (monthIndex < 0 || monthIndex >= DEFAULT_MONTHS) continue;

      const cohort = cohortMap.get(firstInfo.cohortKey);
      const m = cohort.months[monthIndex];

      m.total_sales += order.amount || 0;
      m._unique.add(order.normalizedPhone);

      // 🔥 Product duration distribution (UNCHANGED)
      let duration = 1;
      if (order.productsOrdered) {
        for (const p of order.productsOrdered) {
          duration = Math.max(duration, getDurationInMonths(p));
        }
      }

      for (let i = monthIndex; i < monthIndex + duration && i < DEFAULT_MONTHS; i++) {
        cohort.months[i]._retain.add(order.normalizedPhone);
      }
    }

    const results = [...cohortMap.entries()].map(([key, cohort]) => {
      let validMonthsCount = 0;
      let totalRetention = 0;

      for (let i = 0; i < cohort.months.length; i++) {
        const m = cohort.months[i];
        
        m.customers = m._unique.size;

        m.retention =
          cohort.totalCustomers > 0
            ? +(m._retain.size / cohort.totalCustomers).toFixed(4)
            : 0;

        if (m.customers > 0) {
          m.aov = +(m.total_sales / m.customers).toFixed(2);
        }

        // Count valid months for average retention
        if (m._retain.size > 0) {
          validMonthsCount++;
          totalRetention += m.retention;
        }

        delete m._unique;
        delete m._retain;
      }

      // 🔥 Calculate average retention across M0-M11
      const avgRetention = validMonthsCount > 0 
        ? +(totalRetention / validMonthsCount).toFixed(4)
        : 0;

      return {
        cohort: key,
        customers: cohort.totalCustomers,
        avgRetention, // 🔥 NEW FIELD
        months: cohort.months,
      };
    });

    // Sort by cohort date
    results.sort((a, b) => {
      const [ay, am] = a.cohort.split("-");
      const [by, bm] = b.cohort.split("-");
      return new Date(ay, am - 1) - new Date(by, bm - 1);
    });
 
    
    if (results.length > 0) { 
    }

    setCohortCache(cacheKey, { cohorts: results });
    return res.json({ cohorts: results });

  } catch (err) {
    console.error("❌ COHORT ERROR:", err);
    console.error("Stack:", err.stack);
    return res.status(500).json({ 
      error: "Failed to compute cohort",
      details: err.message 
    });
  }
});

const customerTrendsCache = new Map();
function getCustomerTrendsCache(key) {
  const entry = customerTrendsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    customerTrendsCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCustomerTrendsCache(key, data, ttl = 300000) { 
  customerTrendsCache.set(key, { data, expires: Date.now() + ttl });
}

router.get("/customer-trends", async (req, res) => {
  try {
    let { start, end, compareStart, compareEnd } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "dates required" });
    }

    const cacheKey = `cust_trends_${start}_${end}_${compareStart || ""}_${compareEnd || ""}`;
    const cached = getCustomerTrendsCache(cacheKey);
    if (cached) { 
      return res.json(cached);
    }

    console.time("⏱️ CUSTOMER_TRENDS");

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);
    const isSingle = start === end;
 
    const lookbackDate = new Date(startDate);
    lookbackDate.setDate(lookbackDate.getDate() - 60); 

    // Get customers who had orders in this window
    const relevantCustomerPhones = await ShopifyOrder.aggregate([
      {
        $match: {
          normalizedPhone: { $exists: true, $ne: "" },
          shopifyCreatedAt: { $gte: lookbackDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: "$normalizedPhone"
        }
      }
    ]).allowDiskUse(true);

    const relevantPhones = new Set(relevantCustomerPhones.map(doc => doc._id)); 

    // Now get complete order history ONLY for these customers
    const customerOrderHistory = await ShopifyOrder.aggregate([
      {
        $match: {
          normalizedPhone: { $in: Array.from(relevantPhones) },
          shopifyCreatedAt: { $exists: true }
        }
      },
      {
        $sort: { normalizedPhone: 1, shopifyCreatedAt: 1 }
      },
      {
        $group: {
          _id: "$normalizedPhone",
          allOrders: { 
            $push: "$shopifyCreatedAt"
          },
          firstOrderEver: { $first: "$shopifyCreatedAt" },
          lastOrderEver: { $last: "$shopifyCreatedAt" }
        }
      }
    ]).allowDiskUse(true);

    // Create customer map
    const customerMap = new Map();
    customerOrderHistory.forEach(customer => {
      customerMap.set(customer._id, {
        orders: customer.allOrders.map(d => new Date(d)),
        firstOrderEver: new Date(customer.firstOrderEver),
        lastOrderEver: new Date(customer.lastOrderEver)
      });
    }); 

    // ============================================
    // 🔥 CALCULATE STATS FOR EACH SPECIFIC DATE
    // ============================================
    const calculateStatsForDate = (targetDate) => {
      const activeWindowDays = 60;
      const cutoffDate = new Date(targetDate);
      cutoffDate.setDate(cutoffDate.getDate() - activeWindowDays);

      let newCustomers = 0;
      let activeCustomers = 0;
      let lostCustomers = 0;

      const targetDateStr = new Date(targetDate).toISOString().slice(0, 10);

      customerMap.forEach((history, phone) => {
        const { orders, firstOrderEver } = history;

        // Count NEW customers (first order on this date)
        const firstOrderStr = firstOrderEver.toISOString().slice(0, 10);
        if (firstOrderStr === targetDateStr) {
          newCustomers++;
        }

        // Only evaluate customers who existed by this date
        if (firstOrderEver > targetDate) {
          return;
        }

        // Find most recent order ON OR BEFORE target date
        let lastOrderBeforeTarget = null;
        for (let i = orders.length - 1; i >= 0; i--) {
          if (orders[i] <= targetDate) {
            lastOrderBeforeTarget = orders[i];
            break;
          }
        }

        if (!lastOrderBeforeTarget) {
          return;
        }

        // Determine if ACTIVE or LOST on this specific date
        if (lastOrderBeforeTarget >= cutoffDate && lastOrderBeforeTarget <= targetDate) {
          activeCustomers++;
        } else if (lastOrderBeforeTarget < cutoffDate) {
          lostCustomers++;
        }
      });

      return {
        newCustomers,
        active: activeCustomers,
        lost: lostCustomers
      };
    };

    // ============================================
    // 🔥 PROCESS CURRENT PERIOD DAY-BY-DAY
    // ============================================
    let currentTrends = [];

    if (isSingle) {
      // HOURLY for single day
      const dayStats = calculateStatsForDate(endDate);
      
      // Count new customers per hour
      const hourMap = {};
      customerMap.forEach((history) => {
        const firstOrder = history.firstOrderEver;
        const firstOrderDate = firstOrder.toISOString().slice(0, 10);
        const targetDateStr = endDate.toISOString().slice(0, 10);
        
        if (firstOrderDate === targetDateStr) {
          const hour = firstOrder.getUTCHours();
          hourMap[hour] = (hourMap[hour] || 0) + 1;
        }
      });

      currentTrends = Array.from({ length: 24 }, (_, hour) => ({
        date: `${String(hour).padStart(2, '0')}:00`,
        newCustomers: hourMap[hour] || 0,
        active: dayStats.active,
        lost: dayStats.lost
      }));
 

    } else {
      // DAILY for date range
      const MS_DAY = 86400000;
      let currentDate = new Date(startDate);

      while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().slice(0, 10);
        
        const endOfDay = new Date(currentDate);
        endOfDay.setUTCHours(23, 59, 59, 999);
        
        const stats = calculateStatsForDate(endOfDay);

        currentTrends.push({
          date: dateStr,
          newCustomers: stats.newCustomers,
          active: stats.active,
          lost: stats.lost
        });

        currentDate = new Date(currentDate.getTime() + MS_DAY);
      }
 
    }

    // ============================================
    // 🔥 COMPARISON PERIOD (if provided)
    // ============================================
    if (!compareStart || !compareEnd) {
      console.timeEnd("⏱️ CUSTOMER_TRENDS");
      setCustomerTrendsCache(cacheKey, currentTrends);
      return res.json(currentTrends);
    }

    const compareStartDate = new Date(`${compareStart}T00:00:00.000Z`);
    const compareEndDate = new Date(`${compareEnd}T23:59:59.999Z`);

    const compareLookbackDate = new Date(compareStartDate);
    compareLookbackDate.setDate(compareLookbackDate.getDate() - 60);

    // Get relevant customers for comparison period
    const compareRelevantPhones = await ShopifyOrder.aggregate([
      {
        $match: {
          normalizedPhone: { $exists: true, $ne: "" },
          shopifyCreatedAt: { $gte: compareLookbackDate, $lte: compareEndDate }
        }
      },
      {
        $group: { _id: "$normalizedPhone" }
      }
    ]).allowDiskUse(true);

    const comparePhones = new Set(compareRelevantPhones.map(doc => doc._id));

    const compareOrderHistory = await ShopifyOrder.aggregate([
      {
        $match: {
          normalizedPhone: { $in: Array.from(comparePhones) },
          shopifyCreatedAt: { $exists: true }
        }
      },
      {
        $sort: { normalizedPhone: 1, shopifyCreatedAt: 1 }
      },
      {
        $group: {
          _id: "$normalizedPhone",
          allOrders: { $push: "$shopifyCreatedAt" },
          firstOrderEver: { $first: "$shopifyCreatedAt" },
          lastOrderEver: { $last: "$shopifyCreatedAt" }
        }
      }
    ]).allowDiskUse(true);

    const compareCustomerMap = new Map();
    compareOrderHistory.forEach(customer => {
      compareCustomerMap.set(customer._id, {
        orders: customer.allOrders.map(d => new Date(d)),
        firstOrderEver: new Date(customer.firstOrderEver),
        lastOrderEver: new Date(customer.lastOrderEver)
      });
    });

    const calculateCompareStats = (targetDate) => {
      const cutoffDate = new Date(targetDate);
      cutoffDate.setDate(cutoffDate.getDate() - 60);

      let newCustomers = 0;
      let activeCustomers = 0;
      let lostCustomers = 0;

      const targetDateStr = new Date(targetDate).toISOString().slice(0, 10);

      compareCustomerMap.forEach((history) => {
        const { orders, firstOrderEver } = history;

        const firstOrderStr = firstOrderEver.toISOString().slice(0, 10);
        if (firstOrderStr === targetDateStr) {
          newCustomers++;
        }

        if (firstOrderEver > targetDate) return;

        let lastOrderBeforeTarget = null;
        for (let i = orders.length - 1; i >= 0; i--) {
          if (orders[i] <= targetDate) {
            lastOrderBeforeTarget = orders[i];
            break;
          }
        }

        if (!lastOrderBeforeTarget) return;

        if (lastOrderBeforeTarget >= cutoffDate && lastOrderBeforeTarget <= targetDate) {
          activeCustomers++;
        } else if (lastOrderBeforeTarget < cutoffDate) {
          lostCustomers++;
        }
      });

      return { newCustomers, active: activeCustomers, lost: lostCustomers };
    };

    let compareTrends = [];

    if (isSingle) {
      const compareStats = calculateCompareStats(compareEndDate);
      
      const hourMap = {};
      compareCustomerMap.forEach((history) => {
        const firstOrder = history.firstOrderEver;
        const firstOrderDate = firstOrder.toISOString().slice(0, 10);
        const targetDateStr = compareEndDate.toISOString().slice(0, 10);
        
        if (firstOrderDate === targetDateStr) {
          const hour = firstOrder.getUTCHours();
          hourMap[hour] = (hourMap[hour] || 0) + 1;
        }
      });

      compareTrends = Array.from({ length: 24 }, (_, hour) => ({
        date: `${String(hour).padStart(2, '0')}:00`,
        compareNewCustomers: hourMap[hour] || 0,
        compareActive: compareStats.active,
        compareLost: compareStats.lost
      }));

    } else {
      const MS_DAY = 86400000;
      let currentDate = new Date(compareStartDate);

      while (currentDate <= compareEndDate) {
        const dateStr = currentDate.toISOString().slice(0, 10);
        
        const endOfDay = new Date(currentDate);
        endOfDay.setUTCHours(23, 59, 59, 999);
        
        const stats = calculateCompareStats(endOfDay);

        compareTrends.push({
          date: dateStr,
          compareNewCustomers: stats.newCustomers,
          compareActive: stats.active,
          compareLost: stats.lost
        });

        currentDate = new Date(currentDate.getTime() + MS_DAY);
      }
    }

    // MERGE both periods
    const timeMap = new Map();
    
    currentTrends.forEach(t => {
      timeMap.set(t.date, { ...t });
    });

    compareTrends.forEach(t => {
      if (timeMap.has(t.date)) {
        Object.assign(timeMap.get(t.date), {
          compareNewCustomers: t.compareNewCustomers,
          compareActive: t.compareActive,
          compareLost: t.compareLost
        });
      } else {
        timeMap.set(t.date, {
          date: t.date,
          newCustomers: 0,
          active: 0,
          lost: 0,
          compareNewCustomers: t.compareNewCustomers,
          compareActive: t.compareActive,
          compareLost: t.compareLost
        });
      }
    });

    const mergedTrends = Array.from(timeMap.values());
    mergedTrends.sort((a, b) => a.date.localeCompare(b.date));

    console.timeEnd("⏱️ CUSTOMER_TRENDS"); 

    setCustomerTrendsCache(cacheKey, mergedTrends);
    return res.json(mergedTrends);

  } catch (err) {
    console.error("❌ CUSTOMER TRENDS ERROR:", err);
    console.error("Stack trace:", err.stack);
    return res.status(500).json({ 
      error: "Failed to load customer trends",
      details: err.message 
    });
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

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);
    const isSingleDay = start === end;

    // PAYMENT FILTER
    let paymentMatch = {};
    if (filter === "cod") paymentMatch = { financial_status: { $ne: "paid" } };
    if (filter === "prepaid") paymentMatch = { financial_status: "paid" };

    // ------------------------------------------------------
    // CASE 1: NO COMPARISON → Return normal daily / hourly
    // ------------------------------------------------------
    if (!compareStart || !compareEnd) {
      let pipeline = [];

      if (isSingleDay) {
        // HOURLY
        pipeline = [
          {
            $match: {
              shopifyCreatedAt: { $gte: startDate, $lte: endDate },
              ...paymentMatch,
            },
          },
          {
            $group: {
              _id: { hour: { $hour: "$shopifyCreatedAt" } },
              orders: { $sum: 1 },
            },
          },
          { $sort: { "_id.hour": 1 } },
        ];

        const hourly = await ShopifyOrder.aggregate(pipeline);

        const trend = Array.from({ length: 24 }, (_, h) => ({
          time: `${String(h).padStart(2, "0")}:00`,
          current: hourly.find((x) => x._id.hour === h)?.orders || 0,
          previous: 0,
        }));

        return res.json({
          total: trend.reduce((s, x) => s + x.current, 0),
          trend,
          isSingleDay: true,
          hasComparison: false,
        });
      }

      // DAILY RANGE
      pipeline = [
        {
          $match: {
            shopifyCreatedAt: { $gte: startDate, $lte: endDate },
            ...paymentMatch,
          },
        },
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" },
              },
            },
            orders: { $sum: 1 },
          },
        },
        { $sort: { "_id.date": 1 } },
      ];

      const daily = await ShopifyOrder.aggregate(pipeline);

      const days = [];
      let cursor = new Date(startDate);

      while (cursor <= endDate) {
        const key = cursor.toISOString().slice(0, 10);
        const found = daily.find((d) => d._id.date === key);

        days.push({
          time: key,
          current: found ? found.orders : 0,
          previous: 0,
        });

        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      return res.json({
        total: days.reduce((s, x) => s + x.current, 0),
        trend: days,
        isSingleDay: false,
        hasComparison: false,
      });
    }

    // ------------------------------------------------------
    // CASE 2: COMPARISON MODE (Always Single-Day Hourly)
    // ------------------------------------------------------

    const currentDayStart = new Date(`${end}T00:00:00.000Z`);
    const currentDayEnd = new Date(`${end}T23:59:59.999Z`);

    const compareDayStart = new Date(`${compareStart}T00:00:00.000Z`);
    const compareDayEnd = new Date(`${compareStart}T23:59:59.999Z`);

    const hourlyPipeline = (from, to) => [
      {
        $match: {
          shopifyCreatedAt: { $gte: from, $lte: to },
          ...paymentMatch,
        },
      },
      {
        $group: {
          _id: { hour: { $hour: "$shopifyCreatedAt" } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { "_id.hour": 1 } },
    ];

    const [curr, prev] = await Promise.all([
      ShopifyOrder.aggregate(hourlyPipeline(currentDayStart, currentDayEnd)),
      ShopifyOrder.aggregate(hourlyPipeline(compareDayStart, compareDayEnd)),
    ]);

    const trend = Array.from({ length: 24 }, (_, h) => ({
      time: `${String(h).padStart(2, "0")}:00`,
      current: curr.find((x) => x._id.hour === h)?.orders || 0,
      previous: prev.find((x) => x._id.hour === h)?.orders || 0,
    }));

    const currentTotal = trend.reduce((s, x) => s + x.current, 0);
    const previousTotal = trend.reduce((s, x) => s + x.previous, 0);

    let percentChange = 0;
    if (previousTotal > 0) {
      percentChange = ((currentTotal - previousTotal) / previousTotal) * 100;
    } else if (currentTotal > 0) {
      percentChange = 100;
    }

    const response = {
      total: currentTotal,
      previousTotal,
      percentChange: Number(percentChange.toFixed(2)),

      comparison: {
        total: previousTotal,
        currentDay: end,
        previousDay: compareStart,
        percentChange: Number(percentChange.toFixed(2)),
      },

      currentRange: { start, end },
      previousRange: { start: compareStart, end: compareEnd },

      trend,
      isSingleDay: true,
      hasComparison: true,
    };

    return res.json(response);
  } catch (err) {
    console.error("ORDERS TREND ERROR:", err);
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
 
      setCache(cacheKey, response, 30000); // 30s

      res.json(response);

    } catch (err) {
      console.error("SUMMARY ERROR:", err);
      res.status(500).json({ error: "Failed to fetch summary" });
    }
  });
router.get("/orders-vs-fulfilled", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start & end required" });

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`); 

    // ============================================
    // STEP 1: Get orders placed in date range
    // ============================================
    const shopifyOrders = await ShopifyOrder.aggregate([
      {
        $match: {
          $or: [
            { orderDate: { $gte: startDate, $lte: endDate } },
            { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
          ],
        },
      },
      {
        $project: {
          orderKey: {
            $replaceAll: {
              input: { $ifNull: ["$orderName", ""] },
              find: "#",
              replacement: "",
            },
          },
          fulfillment_status: 1,
          financial_status: 1,
          channelName: 1,
        },
      },
    ]).allowDiskUse(true);

    const totalOrders = shopifyOrders.length;
    const orderKeys = shopifyOrders.map(o => o.orderKey).filter(Boolean); 
 
    const orderStatuses = await Order.aggregate([
      {
        $match: {
          order_id: { $in: orderKeys }
        }
      },
      {
        $project: {
          order_id: 1,
          shipment_status: { 
            $toLower: { 
              $trim: { 
                input: { $ifNull: ["$shipment_status", ""] } 
              } 
            } 
          }
        }
      }
    ]);

    // Create lookup map
    const statusMap = new Map(
      orderStatuses.map(o => [o.order_id, o.shipment_status])
    );
 
    let fulfilledCount = 0;
    let deliveredCount = 0;
    let rtoCount = 0;

    shopifyOrders.forEach(order => {
      const shipmentStatus = statusMap.get(order.orderKey) || "";
      const fulfillStatus = (order.fulfillment_status || "").toLowerCase().trim();
      const financialStatus = (order.financial_status || "").toLowerCase().trim();
      const channelName = (order.channelName || "").toLowerCase().trim();

      // ✅ DELIVERED (exact match "delivered" only, NOT "rto delivered")
      if (shipmentStatus === "delivered") {
        deliveredCount++;
      }

      // ✅ RTO (includes both "rto" AND "rto delivered")
      if (shipmentStatus === "rto" || shipmentStatus === "rto delivered") {
        rtoCount++;
      }

      // ✅ FULFILLED (from ShopifyOrder logic)
      if (
        channelName === "205650526209" ||
        channelName.includes("shopify_draft_order") ||
        financialStatus === "paid" ||
        (financialStatus !== "paid" && fulfillStatus === "fulfilled")
      ) {
        fulfilledCount++;
      }
    });

    const pct = (count) => totalOrders ? Number(((count * 100) / totalOrders).toFixed(1)) : 0;

    return res.json({
      version: "funnel-v2",
      dateRange: { start, end },
      totalOrders,
      fulfilled: { 
        count: fulfilledCount, 
        percentage: pct(fulfilledCount) 
      },
      delivered: { 
        count: deliveredCount, 
        percentage: pct(deliveredCount) 
      },
      rto: { 
        count: rtoCount, 
        percentage: pct(rtoCount) 
      },
    });
    
  } catch (err) {
    console.error("❌ FUNNEL ERROR:", err);
    return res.status(500).json({ 
      error: "Failed to compute funnel", 
      details: err.message 
    });
  }
}); 
 router.get("/comprehensive-summary", async (req, res) => {
    try {
      const { start, end } = req.query;

      if (!start || !end) {
        return res.status(400).json({ error: "start & end required" });
      }

      const cacheKey = `comprehensive_${start}_${end}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      const startDate = new Date(`${start}T00:00:00.000Z`);
      const endDate = new Date(`${end}T23:59:59.999Z`);

      const ONLINE_ID = CHANNEL_MAP["Online Order"];
      const TEAM_ID = CHANNEL_MAP.Team;

      // ============================================
      // STEP 1: Get all ShopifyOrders with required fields
      // ============================================
      const shopifyOrders = await ShopifyOrder.aggregate([
        {
          $match: {
            $or: [
              { orderDate: { $gte: startDate, $lte: endDate } },
              { shopifyCreatedAt: { $gte: startDate, $lte: endDate } },
            ],
          },
        },
        {
          $project: {
            orderKey: {
              $replaceAll: {
                input: { $ifNull: ["$orderName", ""] },
                find: "#",
                replacement: "",
              },
            },
            amount: 1,
            financial_status: 1,
            channelName: 1,
            assignedAgentName: "$orderConfirmOps.assignedAgentName",
          },
        },
      ]).allowDiskUse(true);

      const orderKeys = shopifyOrders.map((o) => o.orderKey).filter(Boolean);

      // ============================================
      // STEP 2: Get shipment statuses from Order.js
      // ============================================
      const orderStatuses = await Order.aggregate([
        {
          $match: {
            order_id: { $in: orderKeys },
          },
        },
        {
          $project: {
            order_id: 1,
            shipment_status: {
              $toLower: {
                $trim: {
                  input: { $ifNull: ["$shipment_status", ""] },
                },
              },
            },
          },
        },
      ]);

      const statusMap = new Map(
        orderStatuses.map((o) => [o.order_id, o.shipment_status])
      );

      // ============================================
      // STEP 3: Calculate metrics for each category
      // ============================================
      const calculateMetrics = (orders) => {
        let totalOrders = 0;
        let totalAmount = 0;

        let prepaidCount = 0,
          prepaidAmount = 0;
        let codCount = 0,
          codAmount = 0;

        let deliveredCount = 0,
          deliveredAmount = 0;
        let undeliveredCount = 0,
          undeliveredAmount = 0;
        let rtoCount = 0,
          rtoAmount = 0;

        orders.forEach((order) => {
          const amt = order.amount || 0;
          totalOrders++;
          totalAmount += amt;

          const isPrepaid = order.financial_status === "paid";
          const status = statusMap.get(order.orderKey) || "";

          // Payment Mode
          if (isPrepaid) {
            prepaidCount++;
            prepaidAmount += amt;
          } else {
            codCount++;
            codAmount += amt;
          }

          // Delivery Status
          if (status === "delivered") {
            deliveredCount++;
            deliveredAmount += amt;
          } else if (status === "rto" || status === "rto delivered") {
            rtoCount++;
            rtoAmount += amt;
          } else {
            undeliveredCount++;
            undeliveredAmount += amt;
          }
        });

        const safePercent = (count, total) =>
          total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0;

        const safeAmountPercent = (amount, totalAmt) =>
          totalAmt > 0 ? Number(((amount / totalAmt) * 100).toFixed(1)) : 0;

        return {
          totalOrders,
          totalAmount,
          aov: totalOrders > 0 ? Number((totalAmount / totalOrders).toFixed(2)) : 0,

          prepaid: {
            count: prepaidCount,
            orderPercent: safePercent(prepaidCount, totalOrders),
            amount: prepaidAmount,
            amountPercent: safeAmountPercent(prepaidAmount, totalAmount),
          },

          cod: {
            count: codCount,
            orderPercent: safePercent(codCount, totalOrders),
            amount: codAmount,
            amountPercent: safeAmountPercent(codAmount, totalAmount),
          },

          delivered: {
            count: deliveredCount,
            orderPercent: safePercent(deliveredCount, totalOrders),
            amount: deliveredAmount,
            amountPercent: safeAmountPercent(deliveredAmount, totalAmount),
          },

          undelivered: {
            count: undeliveredCount,
            orderPercent: safePercent(undeliveredCount, totalOrders),
            amount: undeliveredAmount,
            amountPercent: safeAmountPercent(undeliveredAmount, totalAmount),
          },

          rto: {
            count: rtoCount,
            orderPercent: safePercent(rtoCount, totalOrders),
            amount: rtoAmount,
            amountPercent: safeAmountPercent(rtoAmount, totalAmount),
          },
        };
      };

      // ============================================
      // STEP 4: Filter orders by category
      // ============================================
      const teamOrders = shopifyOrders.filter((o) => {
        const hasAgent =
          o.assignedAgentName && o.assignedAgentName.trim() !== "";
        return hasAgent || o.channelName === TEAM_ID;
      });

      const shopifyOnlyOrders = shopifyOrders.filter((o) => {
        const hasAgent =
          o.assignedAgentName && o.assignedAgentName.trim() !== "";
        return o.channelName === ONLINE_ID && !hasAgent;
      });

      // ============================================
      // STEP 5: Calculate all metrics
      // ============================================
      const totalMetrics = calculateMetrics(shopifyOrders);
      const teamMetrics = calculateMetrics(teamOrders);
      const shopifyMetrics = calculateMetrics(shopifyOnlyOrders);

      const response = {
        dateRange: { start, end },
        total: totalMetrics,
        team: teamMetrics,
        shopify: shopifyMetrics,
      };
 
      setCache(cacheKey, response, 30000);

      return res.json(response);
    } catch (err) {
      console.error("❌ COMPREHENSIVE SUMMARY ERROR:", err);
      return res.status(500).json({
        error: "Failed to fetch comprehensive summary",
        details: err.message,
      });
    }
  });

router.get("/escalation-priority-stats", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "start and end required" });
    }

    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);
 

    // ✅ ONLY GET OPEN ESCALATIONS - Just createdAt for counting
    const OPEN_STATUSES = ["Open", "In Progress"];

    const escalations = await Escalation.find({
      createdAt: { $gte: startDate, $lte: endDate },
      status: { $in: OPEN_STATUSES }
    })
      .select('createdAt')  // ✅ ONLY SELECT createdAt - much faster
      .lean();

    const now = new Date();

    // ✅ COUNT ONLY - No detailed data
    let lowPriority = 0;      // 0-2 days
    let mediumPriority = 0;   // 3-4 days
    let highPriority = 0;     // 5+ days

    escalations.forEach(esc => {
      const createdDate = new Date(esc.createdAt);
      const daysDiff = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

      // ✅ CORRECT BUCKETING LOGIC
      if (daysDiff <= 2) {
        lowPriority++;
      } else if (daysDiff >= 3 && daysDiff <= 4) {
        mediumPriority++;
      } else {
        highPriority++;
      }
    });

    const total = escalations.length;

    const response = {
      dateRange: { start, end },
      summary: {
        total,
        lowPriority,      // 0-2 days
        mediumPriority,   // 3-4 days
        highPriority      // 5+ days
      }
      // ✅ NO DETAILED ESCALATION DATA - just counts
    };
 

    return res.json(response);

  } catch (err) {
    console.error("ESCALATION PRIORITY ERROR:", err);
    return res.status(500).json({ 
      error: "Failed to fetch escalation priorities",
      details: err.message 
    });
  }
});
  module.exports = router;   


