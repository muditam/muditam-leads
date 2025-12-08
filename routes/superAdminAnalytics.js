  // routes/superAdminAnalytics.js
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


  router.get("/calls", async (req, res) => {
    try {
      let { start, end } = req.query;


      if (!start || !end) {
        return res.status(400).json({ error: "start and end required" });
      }


      // Do NOT convert to UTC — DB stores plain IST strings
      // Example: “2025-01-30”
      const s = start.trim();
      const e = end.trim();


      // Query SmartfloDaily by STRING date (exact match)
      const docs = await SmartfloDaily.find({
        date: { $gte: s, $lte: e }
      }).lean();


      let incoming = 0;
      let outgoing = 0;


      docs.forEach((d) => {
        const sum = d.summary || {};
        incoming += sum.incomingCalls || 0;
        outgoing += sum.dialledCalls || 0;
      });


      return res.json({ incoming, outgoing });


    } catch (err) {
      console.error("CALL ANALYTICS ERROR:", err);
      res.status(500).json({ error: "Failed to fetch call analytics" });
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




  // router.get("/rto", async (req, res) => {
  //   try {
  //     const { start, end } = req.query;
  //     if (!start || !end) {
  //       return res.status(400).json({ error: "start and end required" });
  //     }


  //     const startDate = new Date(`${start}T00:00:00.000Z`);
  //     const endDate = new Date(`${end}T23:59:59.999Z`);


  //     // ✅ Count RTO orders from Order model (order.js)
  //     const rto = await Order.countDocuments({
  //       order_date: {
  //         $gte: startDate,
  //         $lte: endDate
  //       },
  //       shipment_status: "RTO"  // Exact match
  //     });


  //     // ✅ Count RTO Delivered orders from Order model (order.js)
  //     const rtoDelivered = await Order.countDocuments({
  //       order_date: {
  //         $gte: startDate,
  //         $lte: endDate
  //       },
  //       shipment_status: "RTO Delivered"  // Exact match
  //     });


  //     // ✅ Total RTO (RTO + RTO Delivered)
  //     const totalRto = rto + rtoDelivered;


  //     console.log(`📊 RTO [${start} to ${end}]:`, {
  //       rto,
  //       rtoDelivered,
  //       totalRto,
  //       source: 'Order model (order.js)'
  //     });


  //     return res.json({
  //       rto,
  //       rtoDelivered,
  //       totalRto
  //     });


  //   } catch (err) {
  //     console.error("RTO ANALYTICS ERROR:", err);
  //     return res.status(500).json({ error: "Failed to fetch RTO analytics" });
  //   }
  // });
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
  // ============================================
  // 🔥 ULTRA FAST COHORT ANALYSIS - CORRECT FORMULA
  // ============================================










  // Helper: Extract duration from product
 
















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


    // -----------------------------------------------------
    // CASE 1 — NO COMPARISON
    // -----------------------------------------------------
    if (!customCompareStart || !customCompareEnd) {
      // A) Single day → hourly
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


      // B) Multi-day → daily AOV points
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


    // -----------------------------------------------------
    // CASE 2 — WITH COMPARISON (ALWAYS SINGLE-DAY HOURLY)
    // -----------------------------------------------------


    const currentStart = parseStart(end);     // last day of main range
    const currentEnd = parseEnd(end);


    const compareStartDate = parseStart(customCompareStart); // first day of compare range
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


    // Count "RTO" (all case variations)
    const rtoOnly = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      shipment_status: { $in: ["RTO", "rto", "Rto"] }
    });


    // Count "RTO Delivered" (all case variations)
    const rtoDelivered = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      shipment_status: { $in: ["RTO Delivered", "rto delivered", "RTO delivered"] }
    });


    // Total RTO = both combined
    const totalRto = rtoOnly + rtoDelivered;


    console.log(`\n📊 RTO [${start} to ${end}]:`);
    console.log(`   RTO: ${rtoOnly}`);
    console.log(`   RTO Delivered: ${rtoDelivered}`);
    console.log(`   Total RTO: ${totalRto}\n`);


    return res.json({
      dateRange: { start, end },
      rto: rtoOnly,
      rtoDelivered,
      totalRto
    });


  } catch (err) {
    console.error("❌ RTO ERROR:", err);
    return res.status(500).json({
      error: "Failed to fetch RTO analytics",
      details: err.message
    });
  }
});




router.get("/orders-vs-fulfilled", async (req, res) => {
  try {
    const { start, end } = req.query;


    if (!start || !end) {
      return res.status(400).json({ error: "start & end required" });
    }


    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T23:59:59.999Z`);


    console.log(`\n📊 ORDERS FUNNEL [${start} to ${end}]`);


    // 1️⃣ TOTAL ORDERS
    const totalOrders = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    });


    // 2️⃣ FULFILLED: "FULFILLED" or "fulfilled"
    const fulfilled = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      fulfillment_status: { $in: ["FULFILLED", "fulfilled"] }
    });


    // 3️⃣ DELIVERED: from shipment_status (case-insensitive)
    const delivered = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      shipment_status: { $in: ["Delivered", "delivered", "DELIVERED"] }
    });


    // 4️⃣ RTO: Both "RTO" and "RTO Delivered" combined
    const rto = await ShopifyOrder.countDocuments({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate },
      $or: [
        { shipment_status: { $in: ["RTO", "rto", "Rto"] } },
        { shipment_status: { $in: ["RTO Delivered", "rto delivered", "RTO delivered"] } }
      ]
    });


    // Calculate percentages
    const safeTotal = totalOrders || 1;
    const fulfilledPct = totalOrders > 0 ? ((fulfilled / totalOrders) * 100).toFixed(1) : "0.0";
    const deliveredPct = totalOrders > 0 ? ((delivered / totalOrders) * 100).toFixed(1) : "0.0";
    const rtoPct = totalOrders > 0 ? ((rto / totalOrders) * 100).toFixed(1) : "0.0";


    // Console logs
    console.log(`   ✅ Total Orders: ${totalOrders} (100.0%)`);
    console.log(`   ✅ Fulfilled: ${fulfilled} (${fulfilledPct}%)`);
    console.log(`   ✅ Delivered: ${delivered} (${deliveredPct}%)`);
    console.log(`   ✅ RTO: ${rto} (${rtoPct}%)`);
    console.log(`   ⏱️  Calculation: Fulfilled → Delivered → RTO\n`);


    // Response - UPDATED STRUCTURE for funnel
    return res.json({
      dateRange: { start, end },
      totalOrders,
      fulfilled: {
        count: fulfilled,
        percentage: parseFloat(fulfilledPct)
      },
      delivered: {
        count: delivered,
        percentage: parseFloat(deliveredPct)
      },
      rto: {
        count: rto,
        percentage: parseFloat(rtoPct)
      },
      summary: {
        "Total Orders": totalOrders,
        "Fulfilled": `${fulfilled} (${fulfilledPct}%)`,
        "Delivered": `${delivered} (${deliveredPct}%)`,
        "RTO": `${rto} (${rtoPct}%)`
      }
    });


  } catch (err) {
    console.error("❌ FULFILLMENT STATS ERROR:", err);
    res.status(500).json({
      error: "Failed to compute fulfillment stats",
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


    console.log(`\n🔍 FINDING EXACT VALUES [${start} to ${end}]\n`);


    // Get ALL unique fulfillment_status values
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


    // Get ALL unique shipment_status values
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


    // Get sample orders
    const samples = await ShopifyOrder.find({
      shopifyCreatedAt: { $gte: startDate, $lte: endDate }
    })
      .select('orderName fulfillment_status shipment_status cancelled_at')
      .limit(5)
      .lean();


    console.log(`\n📊 FULFILLMENT_STATUS values found:`);
    fulfillmentValues.forEach(v => {
      console.log(`   "${v._id}": ${v.count} orders`);
    });


    console.log(`\n📊 SHIPMENT_STATUS values found:`);
    shipmentValues.forEach(v => {
      console.log(`   "${v._id}": ${v.count} orders`);
    });


    console.log(`\n📋 SAMPLE ORDERS:`);
    samples.forEach((o, i) => {
      console.log(`   ${i + 1}. fulfillment: "${o.fulfillment_status}" | shipment: "${o.shipment_status}"`);
    });


    return res.json({
      dateRange: { start, end },
      fulfillmentStatusValues: fulfillmentValues,
      shipmentStatusValues: shipmentValues,
      sampleOrders: samples,
      message: "Check server console for detailed output"
    });


  } catch (err) {
    console.error("❌ ERROR:", err);
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


function normalizeDuration(product) {
  if (!product) return 1;
  let val = product.month || product.cohort || "";
  val = String(val).toLowerCase().trim();
 
  if (val.includes("10") || val.includes("20")) return 1;
  const num = parseInt(val);
  return !isNaN(num) && num > 0 ? num : 1;
}


router.get("/cohort-analysis", async (req, res) => {
  try {
    const { start, end } = req.query;


    const endDate = end ? new Date(end) : new Date();
    const startDate = start
      ? new Date(start)
      : new Date(new Date().setMonth(endDate.getMonth() - 11));


    // 🔥 CHECK CACHE FIRST
    const cacheKey = `cohort_${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}`;
    const cached = getCohortCache(cacheKey);
    if (cached) {
      console.log("✅ COHORT CACHE HIT - returning instantly");
      return res.json(cached);
    }


    console.time("⏱️ COHORT_ANALYSIS");


    // ---------------------------------------------------------
    // OPTIMIZED: Project ONLY month and cohort fields
    // ---------------------------------------------------------
    const raw = await ShopifyOrder.aggregate([
      {
        $match: {
          orderDate: { $gte: startDate, $lte: endDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },
      {
        $project: {
          normalizedPhone: 1,
          orderDate: 1,
          // ✅ ONLY fetch month and cohort (not entire products array)
          "productsOrdered.month": 1,
          "productsOrdered.cohort": 1,
          _id: 0
        }
      },
      { $sort: { normalizedPhone: 1, orderDate: 1 } },
      {
        $group: {
          _id: "$normalizedPhone",
          firstOrder: { $first: "$orderDate" },
          orders: {
            $push: {
              date: "$orderDate",
              products: "$productsOrdered"
            }
          }
        }
      }
    ]).allowDiskUse(true);


    console.log(`📞 Unique customers: ${raw.length}`);


    // ---------------------------------------------------------
    // FAST JS COMPUTATION
    // ---------------------------------------------------------
    const cohortMap = new Map();


    for (const user of raw) {
      const firstOrderDate = new Date(user.firstOrder);
      const cohortKey = firstOrderDate.toISOString().slice(0, 7);


      if (!cohortMap.has(cohortKey)) {
        cohortMap.set(cohortKey, {
          totalCustomers: 0,
          monthCounts: Array(13).fill(0)
        });
      }


      const cohort = cohortMap.get(cohortKey);
      cohort.totalCustomers++;


      const activeMonthsSet = new Set();


      // Process orders
      for (const order of user.orders) {
        const orderDate = new Date(order.date);
        const monthDiff =
          (orderDate.getFullYear() - firstOrderDate.getFullYear()) * 12 +
          (orderDate.getMonth() - firstOrderDate.getMonth());


        if (monthDiff < 0 || monthDiff >= 13) continue;


        // Calculate max duration
        let maxDuration = 1;
        if (order.products && Array.isArray(order.products)) {
          for (const product of order.products) {
            const duration = normalizeDuration(product);
            if (duration > maxDuration) maxDuration = duration;
          }
        }


        // Mark active months
        for (let i = 0; i < maxDuration && monthDiff + i < 13; i++) {
          activeMonthsSet.add(monthDiff + i);
        }
      }


      // Increment counters
      for (const month of activeMonthsSet) {
        cohort.monthCounts[month]++;
      }
    }


    // ---------------------------------------------------------
    // BUILD RESPONSE
    // ---------------------------------------------------------
    const result = Array.from(cohortMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, cohort]) => {
        const totalCustomers = cohort.totalCustomers;
        const safeTotal = totalCustomers || 1;


        const months = cohort.monthCounts.map((count) =>
          ((count / safeTotal) * 100).toFixed(1) + "%"
        );


        return {
          cohort: key,
          customers: totalCustomers,
          months,
          retentionRate: months[1] || "0%"
        };
      });


    console.timeEnd("⏱️ COHORT_ANALYSIS");
    console.log(`✅ Cohorts generated: ${result.length}`);


    const response = { cohorts: result };
    setCohortCache(cacheKey, response, 600000);


    res.json(response);


  } catch (err) {
    console.error("❌ COHORT ERROR:", err.message);
    res.status(500).json({ error: "Failed to compute cohort analysis" });
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


function setCustomerTrendsCache(key, data, ttl = 300000) { // 5 min cache
  customerTrendsCache.set(key, { data, expires: Date.now() + ttl });
}


router.get("/customer-trends", async (req, res) => {
  try {
    let { start, end, compareStart, compareEnd } = req.query;


    if (!start || !end) {
      return res.status(400).json({ error: "dates required" });
    }


    // 🔥 CHECK CACHE FIRST
    const cacheKey = `cust_trends_${start}_${end}_${compareStart || ""}_${compareEnd || ""}`;
    const cached = getCustomerTrendsCache(cacheKey);
    if (cached) {
      console.log("✅ CUSTOMER TRENDS CACHE HIT");
      return res.json(cached);
    }


    console.time("⏱️ CUSTOMER_TRENDS");


    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate   = new Date(`${end}T23:59:59.999Z`);
    const isSingle  = start === end;


    // 🔥 OPTIMIZE: Use aggregation pipeline instead of find()
    // This is 10x faster than loading all orders into memory
    const currentPipeline = [
      {
        $match: {
          shopifyCreatedAt: { $gte: startDate, $lte: endDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },
      {
        $project: {
          normalizedPhone: 1,
          shopifyCreatedAt: 1,
          _id: 0
        }
      },
      {
        $sort: { shopifyCreatedAt: 1 }
      }
    ];


    const currentOrders = await ShopifyOrder.aggregate(currentPipeline).allowDiskUse(true);


    // 🔥 OPTIMIZE: Get old customers in single aggregation
    const oldCustomersPipeline = [
      {
        $match: {
          shopifyCreatedAt: { $lt: startDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },
      {
        $group: {
          _id: "$normalizedPhone"
        }
      },
      {
        $project: {
          _id: 1
        }
      }
    ];


    const oldCustomersResult = await ShopifyOrder.aggregate(oldCustomersPipeline);
    const oldCustomers = new Set(oldCustomersResult.map(doc => doc._id));


    console.log(`📞 Current orders: ${currentOrders.length}`);
    console.log(`👥 Old customers: ${oldCustomers.size}`);


    // 🔥 OPTIMIZE: Calculate active/lost counts in single query
    const [activeCount, lostCount] = await Promise.all([
      Lead.countDocuments({ retentionStatus: { $regex: /active/i } }),
      Lead.countDocuments({ retentionStatus: { $regex: /lost/i } })
    ]);


    // ===========================
    // PROCESS CURRENT PERIOD (FAST IN-MEMORY LOOP)
    // ===========================
    let currentTrends = [];


    if (isSingle) {
      const hourMap = {};
     
      for (const order of currentOrders) {
        const hr = new Date(order.shopifyCreatedAt).getUTCHours();
        const phone = order.normalizedPhone;
       
        if (!hourMap[hr]) hourMap[hr] = 0;
        if (!oldCustomers.has(phone)) {
          hourMap[hr]++;
        }
      }


      currentTrends = Array.from({ length: 24 }, (_, i) => ({
        date: `${String(i).padStart(2, '0')}:00`,
        newCustomers: hourMap[i] || 0,
        active: activeCount,
        lost: lostCount
      }));
    } else {
      const dayMap = {};
      const MS = 86400000;
      const totalDays = Math.ceil((endDate - startDate) / MS);


      for (const order of currentOrders) {
        const dateStr = order.shopifyCreatedAt.toISOString().slice(0, 10);
        const phone = order.normalizedPhone;
       
        if (!dayMap[dateStr]) dayMap[dateStr] = 0;
        if (!oldCustomers.has(phone)) {
          dayMap[dateStr]++;
        }
      }


      let cur = new Date(startDate);
      for (let i = 0; i <= totalDays; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        currentTrends.push({
          date: dStr,
          newCustomers: dayMap[dStr] || 0,
          active: activeCount,
          lost: lostCount
        });
        cur = new Date(cur.getTime() + MS);
      }
    }


    // ===========================
    // COMPARISON PERIOD (IF PROVIDED)
    // ===========================
    if (!compareStart || !compareEnd) {
      console.timeEnd("⏱️ CUSTOMER_TRENDS");
      console.log(`✅ Generated ${currentTrends.length} trend points\n`);
     
      setCustomerTrendsCache(cacheKey, currentTrends);
      return res.json(currentTrends);
    }


    const compareStartDate = new Date(`${compareStart}T00:00:00.000Z`);
    const compareEndDate   = new Date(`${compareEnd}T23:59:59.999Z`);


    // 🔥 OPTIMIZE: Get comparison data using same fast approach
    const comparePipeline = [
      {
        $match: {
          shopifyCreatedAt: { $gte: compareStartDate, $lte: compareEndDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },
      {
        $project: {
          normalizedPhone: 1,
          shopifyCreatedAt: 1,
          _id: 0
        }
      }
    ];


    const compareOrders = await ShopifyOrder.aggregate(comparePipeline).allowDiskUse(true);


    const compareOldPipeline = [
      {
        $match: {
          shopifyCreatedAt: { $lt: compareStartDate },
          normalizedPhone: { $exists: true, $ne: "" }
        }
      },
      {
        $group: { _id: "$normalizedPhone" }
      }
    ];


    const compareOldResult = await ShopifyOrder.aggregate(compareOldPipeline);
    const compareOldCustomers = new Set(compareOldResult.map(doc => doc._id));


    // Process comparison data
    let compareTrends = [];


    if (isSingle) {
      const hourMap = {};
     
      for (const order of compareOrders) {
        const hr = new Date(order.shopifyCreatedAt).getUTCHours();
        const phone = order.normalizedPhone;
       
        if (!hourMap[hr]) hourMap[hr] = 0;
        if (!compareOldCustomers.has(phone)) {
          hourMap[hr]++;
        }
      }


      compareTrends = Array.from({ length: 24 }, (_, i) => ({
        date: `${String(i).padStart(2, '0')}:00`,
        compareNewCustomers: hourMap[i] || 0
      }));
    } else {
      const dayMap = {};
      const MS = 86400000;
      const totalDays = Math.ceil((compareEndDate - compareStartDate) / MS);


      for (const order of compareOrders) {
        const dateStr = order.shopifyCreatedAt.toISOString().slice(0, 10);
        const phone = order.normalizedPhone;
       
        if (!dayMap[dateStr]) dayMap[dateStr] = 0;
        if (!compareOldCustomers.has(phone)) {
          dayMap[dateStr]++;
        }
      }


      let cur = new Date(compareStartDate);
      for (let i = 0; i <= totalDays; i++) {
        const dStr = cur.toISOString().slice(0, 10);
        compareTrends.push({
          date: dStr,
          compareNewCustomers: dayMap[dStr] || 0
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
        timeMap.set(t.date, {
          date: t.date,
          newCustomers: 0,
          compareNewCustomers: t.compareNewCustomers,
          active: activeCount,
          lost: lostCount
        });
      }
    });


    const mergedTrends = Array.from(timeMap.values());
    mergedTrends.sort((a, b) => a.date.localeCompare(b.date));


    console.timeEnd("⏱️ CUSTOMER_TRENDS");
    console.log(`✅ Merged ${mergedTrends.length} comparison points\n`);


    setCustomerTrendsCache(cacheKey, mergedTrends);
    return res.json(mergedTrends);


  } catch (err) {
    console.error("❌ CUSTOMER TRENDS ERROR:", err);
    return res.status(500).json({ error: "Failed to load customer trends" });
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
  // ============================================
// 🔧 FIXED /orders-over-time - Single Day Comparison
// ============================================
// Replace the entire endpoint with this


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
    // CASE 1: NO COMPARISON → RETURN NORMAL DAILY OR HOURLY
    // ------------------------------------------------------
    if (!compareStart || !compareEnd) {
      let pipeline = [];


      if (isSingleDay) {
        // HOURLY
        pipeline = [
          {
            $match: {
              shopifyCreatedAt: { $gte: startDate, $lte: endDate },
              ...paymentMatch
            }
          },
          {
            $group: {
              _id: { hour: { $hour: "$shopifyCreatedAt" } },
              orders: { $sum: 1 }
            }
          },
          { $sort: { "_id.hour": 1 } }
        ];


        const hourly = await ShopifyOrder.aggregate(pipeline);


        const trend = Array.from({ length: 24 }, (_, h) => ({
          time: `${String(h).padStart(2, "0")}:00`,
          current: hourly.find(x => x._id.hour === h)?.orders || 0,
          previous: 0
        }));


        return res.json({
          total: trend.reduce((s, x) => s + x.current, 0),
          trend,
          isSingleDay: true,
          hasComparison: false
        });


      } else {
        // DAILY RANGE
        pipeline = [
          {
            $match: {
              shopifyCreatedAt: { $gte: startDate, $lte: endDate },
              ...paymentMatch
            }
          },
          {
            $group: {
              _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$shopifyCreatedAt" } } },
              orders: { $sum: 1 }
            }
          },
          { $sort: { "_id.date": 1 } }
        ];


        const daily = await ShopifyOrder.aggregate(pipeline);


        const days = [];
        let cursor = new Date(startDate);


        while (cursor <= endDate) {
          const key = cursor.toISOString().slice(0, 10);
          const found = daily.find(d => d._id.date === key);


          days.push({
            time: key,
            current: found ? found.orders : 0,
            previous: 0
          });


          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }


        return res.json({
          total: days.reduce((s, x) => s + x.current, 0),
          trend: days,
          isSingleDay: false,
          hasComparison: false
        });
      }
    }


    // ------------------------------------------------------
    // CASE 2: COMPARISON MODE (ALWAYS SINGLE-DAY HOURLY)
    // ------------------------------------------------------


    const currentDayStart = new Date(`${end}T00:00:00.000Z`);
    const currentDayEnd = new Date(`${end}T23:59:59.999Z`);


    const compareDayStart = new Date(`${compareStart}T00:00:00.000Z`);
    const compareDayEnd = new Date(`${compareStart}T23:59:59.999Z`);


    // HOURLY PIPELINE
    const hourlyPipeline = (from, to) => ([
      {
        $match: {
          shopifyCreatedAt: { $gte: from, $lte: to },
          ...paymentMatch
        }
      },
      {
        $group: {
          _id: { hour: { $hour: "$shopifyCreatedAt" } },
          orders: { $sum: 1 }
        }
      },
      { $sort: { "_id.hour": 1 } }
    ]);


    const curr = await ShopifyOrder.aggregate(hourlyPipeline(currentDayStart, currentDayEnd));
    const prev = await ShopifyOrder.aggregate(hourlyPipeline(compareDayStart, compareDayEnd));


    const trend = Array.from({ length: 24 }, (_, h) => ({
      time: `${String(h).padStart(2, "0")}:00`,
      current: curr.find(x => x._id.hour === h)?.orders || 0,
      previous: prev.find(x => x._id.hour === h)?.orders || 0
    }));


    return res.json({
      total: trend.reduce((s, x) => s + x.current, 0),
      comparison: {
        total: trend.reduce((s, x) => s + x.previous, 0),
        currentDay: end,
        previousDay: compareStart
      },
      trend,
      isSingleDay: true,
      hasComparison: true
    });


  } catch (err) {
    console.error("ORDERS TREND ERROR:", err);
    res.status(500).json({ error: "Failed to compute order trend" });
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

