// routes/opsDashboard.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const ShopifyOrder = require("../models/ShopifyOrder");
const Order = require("../models/Order");
const Employee = require("../models/Employee");

// Keep these in sync with the schema enum
const CallStatusEnum = {
  CNP: "CNP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  CALL_BACK_LATER: "CALL_BACK_LATER",
  CANCEL_ORDER: "CANCEL_ORDER",
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));
const getRoleFromReq = (req) => (req.user?.role || req.query.role || "").toString();
const getUserIdFromReq = (req) => (req.user?._id || req.user?.id || req.query.userId || "").toString();

/** Build UTC Date for a given YYYY-MM-DD at IST midnight / 23:59:59.999 */
function istBoundsForDate(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(yyyyMmDd || ""))) return null;
  const start = new Date(`${yyyyMmDd}T00:00:00.000+05:30`);
  const end   = new Date(`${yyyyMmDd}T23:59:59.999+05:30`);
  return { start, end };
}

/** Default to “today” (IST) if range invalid/missing */
function fallbackTodayIstBounds() {
  const now = new Date();
  // Get today's date in IST (YYYY-MM-DD)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return istBoundsForDate(parts);
}

/** Parse requested window from query params sent by the UI */
function getRequestedWindow(req) {
  const range = String(req.query.range || "").trim();
  const startStr = String(req.query.start || "").trim();
  const endStr = String(req.query.end || "").trim();

  if (range.toLowerCase() === "custom" || range === "Custom range") {
    const s = istBoundsForDate(startStr);
    const e = istBoundsForDate(endStr);
    if (s && e) {
      // Use the full window [start-of-start, end-of-end]
      return { start: s.start, end: e.end, meta: { range: "custom", start: startStr, end: endStr } };
    }
    // invalid custom -> fall back to today
    const { start, end } = fallbackTodayIstBounds();
    return { start, end, meta: { range: "Today" } };
  }

  // Presets also send start/end from the UI; trust them if valid
  const s = istBoundsForDate(startStr);
  const e = istBoundsForDate(endStr);
  if (s && e) {
    return { start: s.start, end: e.end, meta: { range: range || "Today", start: startStr, end: endStr } };
  }

  // Fallback
  const { start, end } = fallbackTodayIstBounds();
  return { start, end, meta: { range: "Today" } };
}

function paymentLabelExpression(financialStatusPath) {
  return {
    $switch: {
      branches: [
        {
          case: { $regexMatch: { input: { $ifNull: [financialStatusPath, ""] }, regex: /^paid$/i } },
          then: "Prepaid",
        },
        {
          case: { $regexMatch: { input: { $ifNull: [financialStatusPath, ""] }, regex: /^(pending|payment[\s_-]*pending)$/i } },
          then: "COD",
        },
      ],
      default: "",
    },
  };
}

function trackingStatusGroup(status = "") {
  const raw = String(status || "").trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!raw || raw === "not available" || raw === "0") return "notShipped";
  if (normalized === "shipment_booked" || normalized === "processing" || normalized === "status_pending") return "notShipped";
  if (normalized === "in_transit" || raw.includes("transit")) return "inTransit";
  if (normalized === "ofp" || normalized === "ofd" || (raw.includes("out") && raw.includes("delivery"))) return "outForDelivery";
  if (raw.includes("rto") && (raw.includes("received") || raw.includes("delivered"))) return "rtoReceived";
  if (raw.includes("rto")) return "rtoInitiated";
  if (raw.includes("deliver")) return "delivered";
  if (raw.includes("cancel")) return "canceled";
  if (raw.includes("lost")) return "lostInTransit";
  if (normalized === "refunded") return "refunded";
  if (raw.includes("ship")) return "shipped";
  return "notShipped";
}

function emptyTrackingBucket() {
  return { count: 0, amount: 0 };
}

async function getTrackingDashboard({ start, end, agentScopeId = null }) {
  const pipeline = [];
  if (agentScopeId) {
    pipeline.push({
      $match: {
        assignedAgentId: new mongoose.Types.ObjectId(String(agentScopeId)),
      },
    });
  }

  pipeline.push(
    {
      $addFields: {
        orderIdNoHash: {
          $let: {
            vars: { oid: { $toString: { $ifNull: ["$order_id", ""] } } },
            in: {
              $cond: [
                { $eq: [{ $substrCP: ["$$oid", 0, 1] }, "#"] },
                { $substrCP: ["$$oid", 1, { $subtract: [{ $strLenCP: "$$oid" }, 1] }] },
                "$$oid",
              ],
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: "shopifyorders",
        let: {
          oid: "$orderIdNoHash",
          oidHash: { $concat: ["#", "$orderIdNoHash"] },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ["$orderName", "$$oid"] },
                  { $eq: ["$orderName", "$$oidHash"] },
                ],
              },
            },
          },
          { $limit: 1 },
          {
            $project: {
              orderName: 1,
              orderDate: 1,
              createdAt: 1,
              amount: 1,
              financial_status: 1,
            },
          },
        ],
        as: "shop",
      },
    },
    { $addFields: { shop: { $arrayElemAt: ["$shop", 0] } } },
    {
      $addFields: {
        orderDateEff: { $ifNull: ["$shop.orderDate", { $ifNull: ["$order_date", "$createdAt"] }] },
        amountEff: { $ifNull: ["$shop.amount", 0] },
        paymentModeEff: paymentLabelExpression("$shop.financial_status"),
        carrierEff: { $ifNull: ["$carrier_title", ""] },
      },
    },
    { $match: { orderDateEff: { $gte: start, $lte: end } } },
    {
      $project: {
        shipment_status: 1,
        carrierEff: 1,
        amountEff: 1,
        paymentModeEff: 1,
        orderDateEff: 1,
      },
    },
  );

  const rows = await Order.aggregate(pipeline).allowDiskUse(true);

  const status = {
    delivered: emptyTrackingBucket(),
    inTransit: emptyTrackingBucket(),
    shipped: emptyTrackingBucket(),
    outForDelivery: emptyTrackingBucket(),
    rtoInitiated: emptyTrackingBucket(),
    rtoReceived: emptyTrackingBucket(),
    notShipped: emptyTrackingBucket(),
    canceled: emptyTrackingBucket(),
    lostInTransit: emptyTrackingBucket(),
    refunded: emptyTrackingBucket(),
  };
  const courierMap = new Map();
  const totals = {
    totalOrders: emptyTrackingBucket(),
    codOrders: emptyTrackingBucket(),
    prepaidOrders: emptyTrackingBucket(),
    delayed: emptyTrackingBucket(),
  };
  const now = new Date();

  rows.forEach((row) => {
    const amount = Number(row.amountEff || 0);
    const statusKey = trackingStatusGroup(row.shipment_status);
    const target = status[statusKey] || status.notShipped;
    target.count += 1;
    target.amount += amount;
    totals.totalOrders.count += 1;
    totals.totalOrders.amount += amount;

    if (/cod/i.test(row.paymentModeEff || "")) {
      totals.codOrders.count += 1;
      totals.codOrders.amount += amount;
    } else if (/prepaid/i.test(row.paymentModeEff || "")) {
      totals.prepaidOrders.count += 1;
      totals.prepaidOrders.amount += amount;
    }

    const ageDays = Math.floor((now - new Date(row.orderDateEff || now)) / 86400000);
    if (!["delivered", "rtoReceived", "canceled", "lostInTransit", "refunded"].includes(statusKey) && ageDays > 7) {
      totals.delayed.count += 1;
      totals.delayed.amount += amount;
    }

    const courier = String(row.carrierEff || "").trim();
    if (courier) {
      const existing = courierMap.get(courier) || { label: courier, count: 0, amount: 0 };
      existing.count += 1;
      existing.amount += amount;
      courierMap.set(courier, existing);
    }
  });

  return {
    totals,
    status,
    couriers: Array.from(courierMap.values()).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

/**
 * GET /api/ops-dashboard/metrics
 * Optional: ?agentId=<id>&range=<preset|custom>&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Returns:
 * {
 *   scope: "all" | "agent",
 *   agentId: "..." | null,
 *   window: { range, start, end },
 *   today: {
 *     addLogCount, confirmedCount, cnpCount, cancelCount
 *   }
 * }
 */
router.get("/metrics", async (req, res) => {
  try {
    const role = getRoleFromReq(req) || "";
    const authedUserId = getUserIdFromReq(req);
    const maybeAgentId = String(req.query.agentId || "");

    // Agent scope logic
    let agentScopeId = null;
    if (isValidObjectId(maybeAgentId)) {
      agentScopeId = new mongoose.Types.ObjectId(maybeAgentId);
    } else if (!/^manager$/i.test(role) && isValidObjectId(authedUserId)) {
      // Non-manager defaults to their own id
      agentScopeId = new mongoose.Types.ObjectId(authedUserId);
    }
    const scope = agentScopeId ? "agent" : "all";

    // Time window (IST) from query
    const { start, end, meta } = getRequestedWindow(req);

    // Base clauses (pending & not-fulfilled, matching your OC surface)
    const baseClauses = [
      { financial_status: /^pending$/i },
      { $or: [{ fulfillment_status: { $exists: false } }, { fulfillment_status: { $not: /^fulfilled$/i } }] },
    ];
    if (agentScopeId) {
      baseClauses.push({ "orderConfirmOps.assignedAgentId": agentScopeId });
    }

    // Counts by status within window
    const [confirmedCount, cnpCount, cancelCount, addLogCount, tracking] = await Promise.all([
      ShopifyOrder.countDocuments({
        $and: [
          ...baseClauses,
          { "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED },
          { "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end } },
        ],
      }),
      ShopifyOrder.countDocuments({
        $and: [
          ...baseClauses,
          { "orderConfirmOps.callStatus": CallStatusEnum.CNP },
          { "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end } },
        ],
      }),
      ShopifyOrder.countDocuments({
        $and: [
          ...baseClauses,
          { "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER },
          { "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end } },
        ],
      }),
      // “Add Log” = unique orders whose last log time falls in window
      ShopifyOrder.countDocuments({
        $and: [...baseClauses, { "orderConfirmOps.plusUpdatedAt": { $gte: start, $lte: end } }],
      }),
      getTrackingDashboard({ start, end, agentScopeId }),
    ]);

    res.json({
      scope,
      agentId: agentScopeId ? String(agentScopeId) : null,
      window: { range: meta.range, start: meta.start || req.query.start, end: meta.end || req.query.end },
      today: {
        addLogCount,
        confirmedCount,
        cnpCount,
        cancelCount,
      },
      tracking,
    });
  } catch (err) {
    console.error("GET /ops-dashboard/metrics error:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
}); 

module.exports = router;
 
