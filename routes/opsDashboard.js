// routes/opsDashboard.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const ShopifyOrder = require("../models/ShopifyOrder");
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
    const [confirmedCount, cnpCount, cancelCount, addLogCount] = await Promise.all([
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
    });
  } catch (err) {
    console.error("GET /ops-dashboard/metrics error:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

module.exports = router;
