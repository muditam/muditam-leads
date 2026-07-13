// routes/financeDashboard.js
const express = require("express");
const router = express.Router();

const Order = require("../models/Order");
const ShopifyFinanceOrder = require("../models/ShopifyFinanceOrder");

/* ---------------- helpers ---------------- */

const STATUS_KEYS = {
  delivered: "Delivered",
  rtoDelivered: "RTO Delivered",
  inTransit: "intransit",
};

const STATUS_SET = new Set([
  STATUS_KEYS.delivered.toLowerCase(),
  STATUS_KEYS.rtoDelivered.toLowerCase(),
  STATUS_KEYS.inTransit.toLowerCase(),
]);

function normOrderName(orderName) {
  return (orderName || "").toString().replace(/^#/, "").trim();
}

/** Pick ONE canonical orderAmount; received = sum; balance floored at 0 */
function computeAmountsForOrder() {
  const orderAmount = 0;
  const receivedAmount = 0;

  let balanceAmount = orderAmount - receivedAmount;
  if (balanceAmount < 0) balanceAmount = 0;

  return { orderAmount, receivedAmount, balanceAmount };
}

/* ------------- CRAZY FAST CACHING ---------------- */

const DASHBOARD_TTL_MS = 60 * 1000; // 1 minute cache
const dashboardCache = {
  data: null,
  lastBuiltAt: 0,
};

/* ------------- CORE HEAVY LOGIC (build once) ------------- */

async function buildDashboard() {
  // 1) Pull all Shopify finance orders
  const sfoDocs = await ShopifyFinanceOrder.find({})
    .select("orderName financialStatus")
    .lean();

  if (!sfoDocs.length) {
    const emptyBlock = {
      rows: [],
      totals: { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 },
    };
    return {
      prepaid: { ...emptyBlock, rtoRate: 0 },
      cod: emptyBlock,
    };
  }

  // Prepaid vs COD arrays
  const prepaidNames = [];
  const codNames = [];

  const cleanSet = new Set();

  for (const r of sfoDocs) {
    cleanSet.add(normOrderName(r.orderName));

    const fs = (r.financialStatus || "").toLowerCase();
    if (fs === "paid") prepaidNames.push(r.orderName);
    else if (fs === "pending") codNames.push(r.orderName);
  }

  const allClean = Array.from(cleanSet);

  // 2) Shipment status from Order collection
  const orderDocs = await Order.find(
    { order_id: { $in: allClean } },
    { order_id: 1, shipment_status: 1 }
  ).lean();

  const statusByClean = new Map();
  for (const od of orderDocs) {
    const key = (od.order_id || "").toString();
    const st = (od.shipment_status || "").toString().toLowerCase().trim();
    if (STATUS_SET.has(st)) statusByClean.set(key, st);
  }

  const newAgg = () => ({
    [STATUS_KEYS.delivered]: {
      count: 0,
      orderAmount: 0,
      receivedAmount: 0,
      balanceAmount: 0,
    },
    [STATUS_KEYS.rtoDelivered]: {
      count: 0,
      orderAmount: 0,
      receivedAmount: 0,
      balanceAmount: 0,
    },
    [STATUS_KEYS.inTransit]: {
      count: 0,
      orderAmount: 0,
      receivedAmount: 0,
      balanceAmount: 0,
    },
    totalCount: 0,
  });

  const prepaidAgg = newAgg();
  const codAgg = newAgg();

  const labelFromLower = (stLower) => {
    if (stLower === STATUS_KEYS.delivered.toLowerCase())
      return STATUS_KEYS.delivered;
    if (stLower === STATUS_KEYS.rtoDelivered.toLowerCase())
      return STATUS_KEYS.rtoDelivered;
    return STATUS_KEYS.inTransit;
  };

  const bump = (agg, label, amounts) => {
    const node = agg[label];
    node.count += 1;
    node.orderAmount += amounts.orderAmount;
    node.receivedAmount += amounts.receivedAmount;
    node.balanceAmount += amounts.balanceAmount;
    agg.totalCount += 1;
  };

  const processGroup = (names, agg) => {
    for (const name of names) {
      const clean = normOrderName(name);
      const stLower = statusByClean.get(clean);
      if (!stLower) continue;

      const label = labelFromLower(stLower);

      const { orderAmount, receivedAmount, balanceAmount } =
        computeAmountsForOrder();

      bump(agg, label, { orderAmount, receivedAmount, balanceAmount });
    }
  };

  processGroup(prepaidNames, prepaidAgg);
  processGroup(codNames, codAgg);

  const finish = (agg, withRto = false) => {
    const total = agg.totalCount || 0;
    const labels = [
      STATUS_KEYS.delivered,
      STATUS_KEYS.rtoDelivered,
      STATUS_KEYS.inTransit,
    ];

    const rows = labels.map((label) => {
      const v = agg[label];
      return {
        label,
        count: v.count,
        pct: total ? (v.count / total) * 100 : 0,
        orderAmount: v.orderAmount,
        receivedAmount: v.receivedAmount,
        balanceAmount: v.balanceAmount,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.count += r.count;
        acc.orderAmount += r.orderAmount;
        acc.receivedAmount += r.receivedAmount;
        acc.balanceAmount += r.balanceAmount;
        return acc;
      },
      { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 }
    );

    const out = { rows, totals };
    if (withRto) {
      const rtoCount = agg[STATUS_KEYS.rtoDelivered].count;
      out.rtoRate = total ? (rtoCount / total) * 100 : 0;
    }
    return out;
  };

  return {
    prepaid: finish(prepaidAgg, true),
    cod: finish(codAgg, false),
  };
}

/* ---------------- ROUTE WITH CACHE ---------------- */

router.get("/dashboard", async (req, res) => {
  try {
    const force =
      req.query.force === "1" ||
      req.query.force === "true" ||
      req.query.force === "yes";

    const now = Date.now();
    if (
      !force &&
      dashboardCache.data &&
      now - dashboardCache.lastBuiltAt < DASHBOARD_TTL_MS
    ) {
      return res.json({
        ...dashboardCache.data,
        cached: true,
        generatedAt: new Date(dashboardCache.lastBuiltAt).toISOString(),
      });
    }

    const data = await buildDashboard();
    dashboardCache.data = data;
    dashboardCache.lastBuiltAt = Date.now();

    return res.json({
      ...data,
      cached: false,
      generatedAt: new Date(dashboardCache.lastBuiltAt).toISOString(),
    });
  } catch (err) {
    console.error("dashboard error:", err);
    return res.status(500).json({ error: "Failed to build dashboard" });
  }
});

module.exports = router;
