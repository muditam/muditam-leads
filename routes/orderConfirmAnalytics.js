// routes/order-analytics.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const ShopifyOrder = require("../models/ShopifyOrder");
const Employee = require("../models/Employee");

const CallStatusEnum = {
  CNP: "CNP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  CALL_BACK_LATER: "CALL_BACK_LATER",
  CANCEL_ORDER: "CANCEL_ORDER",
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));

function istBoundsForDate(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyyMmDd || ""))) return null;
  const start = new Date(`${yyyyMmDd}T00:00:00.000+05:30`);
  const end   = new Date(`${yyyyMmDd}T23:59:59.999+05:30`);
  return { start, end };
}

function getWindowFromQuery(req) {
  const range = String(req.query.range || "").trim();
  const startStr = String(req.query.start || "").trim();
  const endStr = String(req.query.end || "").trim();

  const s = istBoundsForDate(startStr);
  const e = istBoundsForDate(endStr);
  if (s && e) {
    return { start: s.start, end: e.end, meta: { range: range || "custom", start: startStr, end: endStr } };
  }

  // Fallback: Today in IST
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const t = istBoundsForDate(todayStr);
  return { start: t.start, end: t.end, meta: { range: "Today", start: todayStr, end: todayStr } };
}

router.get("/agents", async (req, res) => {
  try {
    const { start, end, meta } = getWindowFromQuery(req);

    // Active agents (OC)
    const activeAgents = await Employee.find(
      { orderConfirmActive: true, $or: [{ status: "active" }, { status: "Active" }] },
      { _id: 1, fullName: 1 }
    )
      .sort({ fullName: 1 })
      .lean();

    const agentIdList = activeAgents.map((a) => a._id);
    if (!agentIdList.length) {
      return res.json({ window: meta, items: [], totals: {
        totalOrders: 0, totalWorkedOrders: 0, totalAmountOfOrders: 0, totalAmountOfWorkedOrders: 0
      } });
    }

    // Common base
    const baseMatch = {
      $and: [
        { financial_status: /^pending$/i },
        { $or: [{ fulfillment_status: { $exists: false } }, { fulfillment_status: { $not: /^fulfilled$/i } }] },
        { "orderConfirmOps.assignedAgentId": { $in: agentIdList } },
    ]};

    const createdInWindow = {
      $or: [
        { orderDate: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } },
      ],
    };

    const pipeline = [
      { $match: baseMatch },
      {
        $facet: {
          all: [
            { $match: createdInWindow },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          pending: [
            {
              $match: {
                ...createdInWindow,
                $or: [
                  { "orderConfirmOps.shopifyNotes": { $exists: false } },
                  { "orderConfirmOps.shopifyNotes": "" },
                ],
              },
            },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          confirmed: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          cnp: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CNP,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          callBack: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CALL_BACK_LATER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          cancel: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],
          addLog: [
            { $match: { "orderConfirmOps.plusUpdatedAt": { $gte: start, $lte: end } } },
            { $group: { _id: "$orderConfirmOps.assignedAgentId", c: { $sum: 1 } } },
          ],

          // NEW: window totals (not grouped by agent)
          totalsOrders: [
            { $match: createdInWindow },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],
          totalsWorked: [
            { $match: { "orderConfirmOps.plusUpdatedAt": { $gte: start, $lte: end } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],
        },
      },
    ];

    const [agg] = await ShopifyOrder.aggregate(pipeline);

    const toMap = (arr = []) =>
      arr.reduce((m, r) => {
        m[String(r._id)] = r.c;
        return m;
      }, {});

    const mapAll = toMap(agg?.all);
    const mapPending = toMap(agg?.pending);
    const mapConfirmed = toMap(agg?.confirmed);
    const mapCnp = toMap(agg?.cnp);
    const mapCallBack = toMap(agg?.callBack);
    const mapCancel = toMap(agg?.cancel);
    const mapAddLog = toMap(agg?.addLog);

    const items = activeAgents.map((a) => {
      const id = String(a._id);
      return {
        agentId: id,
        agentName: a.fullName || "",
        counts: {
          all: mapAll[id] || 0,
          pending: mapPending[id] || 0,
          confirmed: mapConfirmed[id] || 0,
          cnp: mapCnp[id] || 0,
          callBack: mapCallBack[id] || 0,
          cancel: mapCancel[id] || 0,
          addLog: mapAddLog[id] || 0,
        },
      };
    });

    const getTotals = (arr) => {
      const row = Array.isArray(arr) && arr[0] ? arr[0] : { count: 0, amount: 0 };
      return { count: row.count || 0, amount: row.amount || 0 };
    };

    const totalsOrders = getTotals(agg?.totalsOrders);
    const totalsWorked = getTotals(agg?.totalsWorked);

    res.json({
      window: meta,
      items,
      totals: {
        totalOrders: totalsOrders.count,
        totalWorkedOrders: totalsWorked.count,
        totalAmountOfOrders: totalsOrders.amount,
        totalAmountOfWorkedOrders: totalsWorked.amount,
      },
    });
  } catch (err) {
    console.error("GET /order-analytics/agents error:", err);
    res.status(500).json({ error: "Failed to compute order analytics" });
  }
});

module.exports = router;
