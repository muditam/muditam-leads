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

// HARD CUTOFF: only show data on/after 1 Oct 2025 (IST)
const START_FROM_ISO = "2025-10-01T00:00:00.000+05:30";
const START_FROM_DATE = new Date(START_FROM_ISO);

function istBoundsForDate(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyyMmDd || ""))) return null;
  const start = new Date(`${yyyyMmDd}T00:00:00.000+05:30`);
  const end = new Date(`${yyyyMmDd}T23:59:59.999+05:30`);
  return { start, end };
}

function getTodayISTString() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function clampStartDate(d) {
  return d < START_FROM_DATE ? START_FROM_DATE : d;
}

function getTodayISTWindow() {
  const todayStr = getTodayISTString();
  const t = istBoundsForDate(todayStr);

  return {
    start: clampStartDate(t.start),
    end: t.end,
    todayStr,
  };
}

function getWindowFromQuery(req) {
  const range = String(req.query.range || "").trim();
  const startStr = String(req.query.start || "").trim();
  const endStr = String(req.query.end || "").trim();

  const s = istBoundsForDate(startStr);
  const e = istBoundsForDate(endStr);

  if (s && e) {
    const start = clampStartDate(s.start);
    const end = e.end;

    return {
      start,
      end,
      meta: {
        range: range || "custom",
        start: startStr,
        end: endStr,
      },
    };
  }

  const { start, end, todayStr } = getTodayISTWindow();

  return {
    start,
    end,
    meta: { range: "Today", start: todayStr, end: todayStr },
  };
}

router.get("/agents", async (req, res) => {
  try {
    const { start, end, meta } = getWindowFromQuery(req);

    // Active OC agents
    const activeAgents = await Employee.find(
      {
        orderConfirmActive: true,
        $or: [{ status: "active" }, { status: "Active" }],
      },
      { _id: 1, fullName: 1 }
    )
      .sort({ fullName: 1 })
      .lean();

    const agentIdList = activeAgents.map((a) => a._id);

    if (!agentIdList.length) {
      return res.json({
        window: meta,
        items: [],
        totals: {
          totalOrders: 0,
          totalWorkedOrders: 0,
          totalAmountOfOrders: 0,
          totalAmountOfWorkedOrders: 0,
        },
      });
    }

    const baseMatch = {
      $and: [
        { financial_status: /^pending$/i },
        {
          $or: [
            { fulfillment_status: { $exists: false } },
            { fulfillment_status: { $not: /^fulfilled$/i } },
          ],
        },
        { "orderConfirmOps.assignedAgentId": { $in: agentIdList } },
      ],
    };

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
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
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
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
          confirmed: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
          cnp: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CNP,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
          callBack: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CALL_BACK_LATER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
          cancel: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
          addLog: [
            {
              $match: {
                "orderConfirmOps.plusUpdatedAt": { $gte: start, $lte: end },
              },
            },
            {
              $group: {
                _id: "$orderConfirmOps.assignedAgentId",
                c: { $sum: 1 },
              },
            },
          ],
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
            {
              $match: {
                "orderConfirmOps.plusUpdatedAt": { $gte: start, $lte: end },
              },
            },
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
      const row =
        Array.isArray(arr) && arr[0] ? arr[0] : { count: 0, amount: 0 };
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

router.get("/agents/:agentId/details", async (req, res) => {
  try {
    const { agentId } = req.params;

    if (!isValidObjectId(agentId)) {
      return res.status(400).json({ error: "Invalid agentId" });
    }

    const agent = await Employee.findById(agentId, {
      _id: 1,
      fullName: 1,
      orderConfirmActive: 1,
      status: 1,
    }).lean();

    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const { start, end, meta } = getWindowFromQuery(req);
    const { start: todayStart, end: todayEnd, todayStr } = getTodayISTWindow();

    const agentObjectId = new mongoose.Types.ObjectId(agentId);

    const baseMatch = {
      $and: [
        { financial_status: /^pending$/i },
        {
          $or: [
            { fulfillment_status: { $exists: false } },
            { fulfillment_status: { $not: /^fulfilled$/i } },
          ],
        },
        { "orderConfirmOps.assignedAgentId": agentObjectId },
      ],
    };

    const confirmedSelectedMatch = {
      "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED,
      "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end },
    };

    const confirmedTodayMatch = {
      "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED,
      "orderConfirmOps.callStatusUpdatedAt": { $gte: todayStart, $lte: todayEnd },
    };

    const effectiveOrderDateExpr = { $ifNull: ["$orderDate", "$createdAt"] };

    const [agg] = await ShopifyOrder.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          confirmedInSelectedWindow: [
            { $match: confirmedSelectedMatch },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],

          confirmedToday: [
            { $match: confirmedTodayMatch },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],

          confirmedTodaySameDate: [
            { $match: confirmedTodayMatch },
            {
              $match: {
                $expr: {
                  $and: [
                    { $gte: [effectiveOrderDateExpr, todayStart] },
                    { $lte: [effectiveOrderDateExpr, todayEnd] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],

          confirmedTodayPreviousDate: [
            { $match: confirmedTodayMatch },
            {
              $match: {
                $expr: {
                  $lt: [effectiveOrderDateExpr, todayStart],
                },
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                amount: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
          ],

          cnpToday: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CNP,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: todayStart, $lte: todayEnd },
              },
            },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],

          callBackToday: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CALL_BACK_LATER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: todayStart, $lte: todayEnd },
              },
            },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],

          cancelToday: [
            {
              $match: {
                "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER,
                "orderConfirmOps.callStatusUpdatedAt": { $gte: todayStart, $lte: todayEnd },
              },
            },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],

          addLogToday: [
            {
              $match: {
                "orderConfirmOps.plusUpdatedAt": { $gte: todayStart, $lte: todayEnd },
              },
            },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],

          confirmedOrdersList: [
            { $match: confirmedSelectedMatch },
            { $sort: { "orderConfirmOps.callStatusUpdatedAt": -1, orderDate: -1, createdAt: -1 } },
            {
              $project: {
                _id: 1,
                orderName: 1,
                customerName: 1,
                contactNumber: 1,
                amount: 1,
                orderDate: 1,
                createdAt: 1,
                confirmedAt: "$orderConfirmOps.callStatusUpdatedAt",
                channelName: 1,
                orderType: {
                  $cond: [
                    { $lt: [effectiveOrderDateExpr, todayStart] },
                    "Previous-date order",
                    "Today order",
                  ],
                },
              },
            },
            { $limit: 300 },
          ],
        },
      },
    ]);

    const one = (arr) =>
      Array.isArray(arr) && arr[0]
        ? arr[0]
        : { count: 0, amount: 0 };

    const oneCount = (arr) =>
      Array.isArray(arr) && arr[0]
        ? arr[0].count || 0
        : 0;

    const selected = one(agg?.confirmedInSelectedWindow);
    const today = one(agg?.confirmedToday);
    const todaySame = one(agg?.confirmedTodaySameDate);
    const todayPrev = one(agg?.confirmedTodayPreviousDate);

    res.json({
      window: meta,
      todayWindow: {
        start: todayStr,
        end: todayStr,
      },
      agent: {
        agentId: String(agent._id),
        agentName: agent.fullName || "",
        orderConfirmActive: !!agent.orderConfirmActive,
        status: agent.status || "",
      },
      summary: {
        confirmedInSelectedWindow: selected.count || 0,
        confirmedAmountInSelectedWindow: selected.amount || 0,

        confirmedToday: today.count || 0,
        confirmedAmountToday: today.amount || 0,

        confirmedTodaySameDate: todaySame.count || 0,
        confirmedTodaySameDateAmount: todaySame.amount || 0,

        confirmedTodayPreviousDate: todayPrev.count || 0,
        confirmedTodayPreviousDateAmount: todayPrev.amount || 0,

        cnpToday: oneCount(agg?.cnpToday),
        callBackToday: oneCount(agg?.callBackToday),
        cancelToday: oneCount(agg?.cancelToday),
        addLogToday: oneCount(agg?.addLogToday),
      },
      items: Array.isArray(agg?.confirmedOrdersList)
        ? agg.confirmedOrdersList
        : [],
    });
  } catch (err) {
    console.error("GET /order-analytics/agents/:agentId/details error:", err);
    res.status(500).json({ error: "Failed to fetch agent details" });
  }
});

module.exports = router;