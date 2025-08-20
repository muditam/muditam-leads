// routes/financeDashboard.js
const express = require("express");
const router = express.Router();

const Order = require("../models/Order");
const ShopifyFinanceOrder = require("../models/ShopifyFinanceOrder");
const EasebuzzTransaction = require("../models/EasebuzzTransaction");
const DtdcSettlement = require("../models/DtdcSettlement");
const DelhiverySettlement = require("../models/DelhiverySettlement");
const BluedartSettlement = require("../models/BluedartSettlement");

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
function variants(orderName) {
  const raw = (orderName || "").toString().trim();   // "#1234"
  const clean = normOrderName(raw);                   // "1234"
  const n = Number(clean);
  const numeric = !Number.isNaN(n) && Number.isFinite(n) && String(n) === clean ? n : null;
  return { raw, clean, numeric };
}

/** Pick ONE canonical "Order Amount" per order; Received = sum of all; Balance floored at 0 */
function computeAmountsForOrder(amtEZ = 0, amtBD = 0, amtDL = 0, amtDTDC = 0) {
  const orderAmount =
    (amtEZ && Number(amtEZ)) ||
    (amtBD && Number(amtBD)) ||
    (amtDL && Number(amtDL)) ||
    (amtDTDC && Number(amtDTDC)) ||
    0;

  const receivedAmount =
    (Number(amtEZ) || 0) + (Number(amtBD) || 0) + (Number(amtDL) || 0) + (Number(amtDTDC) || 0);

  let balanceAmount = orderAmount - receivedAmount;
  if (balanceAmount < 0) balanceAmount = 0;

  return { orderAmount, receivedAmount, balanceAmount };
}

/* ---------------- route ---------------- */

/**
 * GET /api/finance/dashboard
 * No date filters; uses all available data.
 * Returns:
 * {
 *   prepaid: { rows: [{label,count,pct,orderAmount,receivedAmount,balanceAmount}], totals:{...}, rtoRate },
 *   cod:     { rows: [...], totals:{...} }
 * }
 */
router.get("/dashboard", async (req, res) => {
  try {
    // 1) Pull all Shopify finance orders (universe for prepaid/cod split)
    const sfoDocs = await ShopifyFinanceOrder.find({})
      .select("orderName financialStatus")
      .lean();

    if (!sfoDocs.length) {
      return res.json({
        prepaid: { rows: [], totals: { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 }, rtoRate: 0 },
        cod:     { rows: [], totals: { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 } },
      });
    }

    // Split by paid/pending
    const prepaidNames = [];
    const codNames = [];
    for (const r of sfoDocs) {
      const fs = (r.financialStatus || "").toLowerCase();
      if (fs === "paid") prepaidNames.push(r.orderName);
      else if (fs === "pending") codNames.push(r.orderName);
    }

    const allNames = [...prepaidNames, ...codNames];
    const allClean = allNames.map(normOrderName);

    // 2) Fetch Order statuses
    const orderDocs = await Order.find({ order_id: { $in: allClean } })
      .select("order_id shipment_status")
      .lean();

    const mapStatusByClean = new Map();
    for (const od of orderDocs) {
      const key = (od.order_id || "").toString();
      const st = (od.shipment_status || "").toString().toLowerCase().trim();
      if (STATUS_SET.has(st)) mapStatusByClean.set(key, st); // only the 3 we care about
    }

    // 3) Fetch amounts once, index by raw/clean/numeric
    const mapEZ = new Map();     // merchantOrderId -> sum(amount)
    const mapBD = new Map();     // orderId -> sum(customerPayAmt)
    const mapDL = new Map();     // orderId -> sum(amount)
    const mapDTDC = new Map();   // customerReferenceNumber -> sum(remittedAmount)

    const fold = (map, key, val) => {
      if (key === null || key === undefined) return;
      const num = Number(val);
      if (Number.isNaN(num)) return;
      map.set(key, (map.get(key) || 0) + num);
    };

    // Easebuzz
    const ezDocs = await EasebuzzTransaction.find({
      merchantOrderId: { $in: [...allNames, ...allClean] },
    }).select("merchantOrderId amount").lean();
    for (const d of ezDocs) {
      const raw = (d.merchantOrderId ?? "").toString().trim();
      const clean = normOrderName(raw);
      const num = Number(clean);
      fold(mapEZ, raw, d.amount);
      fold(mapEZ, clean, d.amount);
      if (String(num) === clean) fold(mapEZ, num, d.amount);
    }

    // Bluedart
    const bdDocs = await BluedartSettlement.find({
      orderId: { $in: [...allNames, ...allClean] },
    }).select("orderId customerPayAmt").lean();
    for (const d of bdDocs) {
      const raw = (d.orderId ?? "").toString().trim();
      const clean = normOrderName(raw);
      const num = Number(clean);
      fold(mapBD, raw, d.customerPayAmt);
      fold(mapBD, clean, d.customerPayAmt);
      if (String(num) === clean) fold(mapBD, num, d.customerPayAmt);
    }

    // Delhivery
    const dlDocs = await DelhiverySettlement.find({
      orderId: { $in: [...allNames, ...allClean] },
    }).select("orderId amount").lean();
    for (const d of dlDocs) {
      const raw = (d.orderId ?? "").toString().trim();
      const clean = normOrderName(raw);
      const num = Number(clean);
      fold(mapDL, raw, d.amount);
      fold(mapDL, clean, d.amount);
      if (String(num) === clean) fold(mapDL, num, d.amount);
    }

    // DTDC
    const dcDocs = await DtdcSettlement.find({
      customerReferenceNumber: { $in: [...allNames, ...allClean] },
    }).select("customerReferenceNumber remittedAmount").lean();
    for (const d of dcDocs) {
      const raw = (d.customerReferenceNumber ?? "").toString().trim();
      const clean = normOrderName(raw);
      const num = Number(clean);
      fold(mapDTDC, raw, d.remittedAmount);
      fold(mapDTDC, clean, d.remittedAmount);
      if (String(num) === clean) fold(mapDTDC, num, d.remittedAmount);
    }

    const amountsFor = (orderName) => {
      const { raw, clean, numeric } = variants(orderName);
      const get = (map) =>
        (map.get(raw) || 0) +
        (map.get(clean) || 0) +
        (numeric !== null ? (map.get(numeric) || 0) : 0);

      return {
        ez: get(mapEZ),
        bd: get(mapBD),
        dl: get(mapDL),
        dtdc: get(mapDTDC),
      };
    };

    const newAgg = () => ({
      [STATUS_KEYS.delivered]:     { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 },
      [STATUS_KEYS.rtoDelivered]:  { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 },
      [STATUS_KEYS.inTransit]:     { count: 0, orderAmount: 0, receivedAmount: 0, balanceAmount: 0 },
      totalCount: 0,
    });
    const prepaidAgg = newAgg();
    const codAgg = newAgg();

    const bump = (agg, label, amounts) => {
      const node = agg[label];
      node.count += 1;
      node.orderAmount += amounts.orderAmount;
      node.receivedAmount += amounts.receivedAmount;
      node.balanceAmount += amounts.balanceAmount;
      agg.totalCount += 1;
    };

    // Walk each Shopify finance order
    for (const r of sfoDocs) {
      const fs = (r.financialStatus || "").toLowerCase();
      if (fs !== "paid" && fs !== "pending") continue;

      const cleanId = normOrderName(r.orderName);
      const st = mapStatusByClean.get(cleanId);
      if (!st) continue; // only the 3 statuses

      const label =
        st === STATUS_KEYS.delivered.toLowerCase() ? STATUS_KEYS.delivered :
        st === STATUS_KEYS.rtoDelivered.toLowerCase() ? STATUS_KEYS.rtoDelivered :
        STATUS_KEYS.inTransit;

      const a = amountsFor(r.orderName);
      const { orderAmount, receivedAmount, balanceAmount } = computeAmountsForOrder(a.ez, a.bd, a.dl, a.dtdc);

      if (fs === "paid") bump(prepaidAgg, label, { orderAmount, receivedAmount, balanceAmount });
      else bump(codAgg, label, { orderAmount, receivedAmount, balanceAmount });
    }

    const finish = (agg, wantRtoRate = false) => {
      const total = agg.totalCount || 0;
      const rows = [STATUS_KEYS.delivered, STATUS_KEYS.rtoDelivered, STATUS_KEYS.inTransit].map((label) => {
        const n = agg[label];
        return {
          label,
          count: n.count,
          pct: total ? (n.count / total) * 100 : 0,
          orderAmount: n.orderAmount,
          receivedAmount: n.receivedAmount,
          balanceAmount: n.balanceAmount,
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
      if (wantRtoRate) {
        const rto = agg[STATUS_KEYS.rtoDelivered].count;
        out.rtoRate = total ? (rto / total) * 100 : 0;
      }
      return out;
    };

    const prepaid = finish(prepaidAgg, true);
    const cod = finish(codAgg, false);

    return res.json({ prepaid, cod });
  } catch (err) {
    console.error("dashboard error:", err);
    return res.status(500).json({ error: "Failed to build dashboard" });
  }
});

module.exports = router;
