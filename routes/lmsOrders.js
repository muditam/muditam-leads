const express = require("express");
const mongoose = require("mongoose");
const ShopifyOrder = require("../models/ShopifyOrder");
const Order = require("../models/Order");
const Employee = require("../models/Employee");
const requireSession = require("../middleware/requireSession");

const router = express.Router();

const CLOSED_STATUS_KEYS = new Set(["delivered", "delivered_paid_cod", "rto_received", "canceled", "lost"]);
const STATUS_LABELS = {
  not_shipped: "Not Shipped",
  shipped: "Shipped",
  in_transit: "In Transit",
  out_for_delivery: "Out for Delivery",
  ready_for_pickup: "Ready for Pickup",
  delivered: "Delivered",
  delivered_paid_cod: "Delivered & Paid (COD)",
  rto_initiated: "RTO",
  rto_received: "RTO Delivered",
  canceled: "Canceled",
  lost: "Lost",
};
const BASE_STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
  count: 0,
}));
const CLOSED_STATUS_REGEX = /(delivered|rto[\s_-]*(received|delivered)|return[\s_-]*delivered|cancell?ed|lost)/i;
const ACTIVE_ORDERS_START = new Date("2026-04-01T00:00:00.000Z");
const PAGE_SELECT =
  "orderId orderName customerName contactNumber customerAddress orderDate createdAt amount modeOfPayment paymentGatewayNames productsOrdered financial_status fulfillment_status cancelled_at";
const NDR_CLOSING_STATUS_REGEX = /^(delivered|delivered[\s_-]*paid[\s_-]*cod|delivered\s*&\s*paid.*|rto[\s_-]*(received|delivered)|return[\s_-]*delivered|rto_received)$/i;
const NDR_EXCLUDED_PRODUCT_REGEX = /(blood\s*test|full\s*body\s*checkup)/i;
const META_CACHE_TTL_MS = 30000;
const metaCache = new Map();

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cacheKeyForMatch(baseMatch = {}) {
  return JSON.stringify(baseMatch);
}

function clearMetaCache() {
  metaCache.clear();
}

function parseDateStart(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateEnd(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSort(sortBy = "order_date") {
  const map = {
    order_date: "orderDateEff",
    amount: "amount",
    status: "shipmentStatus",
    customer: "customerName",
    order_id: "orderName",
  };
  return map[sortBy] || map.order_date;
}

function normalizeStatusKey(status = "") {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw || raw === "not available") return "not_shipped";
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "cancelled") return "canceled";
  if (normalized === "rto_delivered" || normalized === "return_delivered") return "rto_received";
  if (normalized === "ofd") return "out_for_delivery";
  if (STATUS_LABELS[normalized]) return normalized;
  if (raw.includes("ready") && raw.includes("pickup")) return "ready_for_pickup";
  if (raw.includes("out") && raw.includes("delivery")) return "out_for_delivery";
  if (raw.includes("transit")) return "in_transit";
  if (raw.includes("rto") && (raw.includes("received") || raw.includes("delivered"))) return "rto_received";
  if (raw.includes("rto")) return "rto_initiated";
  if (raw.includes("deliver")) return "delivered";
  if (raw.includes("cancel")) return "canceled";
  if (raw.includes("lost")) return "lost";
  if (raw.includes("ship")) return "shipped";
  return normalized || "not_shipped";
}

function statusLabelFromKey(statusKey) {
  if (STATUS_LABELS[statusKey]) return STATUS_LABELS[statusKey];
  return String(statusKey || "Not Shipped")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusOptionValue(status = "") {
  const raw = String(status || "").trim();
  const key = normalizeStatusKey(raw);
  if (STATUS_LABELS[key]) return key;
  return raw ? `raw:${raw}` : "not_shipped";
}

function statusLabelFromValue(value = "") {
  const raw = String(value || "").trim();
  if (raw.startsWith("raw:")) return raw.slice(4);
  return statusLabelFromKey(normalizeStatusKey(raw));
}

function statusRegexForKey(status = "") {
  if (String(status || "").startsWith("raw:")) {
    return new RegExp(`^${escapeRegex(String(status).slice(4))}$`, "i");
  }
  const key = normalizeStatusKey(status);
  const patterns = {
    not_shipped: /^(not[\s_-]*available|not[\s_-]*shipped|not_shipped|)$/i,
    shipped: /^shipped$/i,
    in_transit: /^(in[\s_-]*transit|in_transit)$/i,
    out_for_delivery: /^(out[\s_-]*for[\s_-]*delivery|out_for_delivery|ofd)$/i,
    ready_for_pickup: /^(ready[\s_-]*for[\s_-]*pickup|ready_for_pickup)$/i,
    delivered: /^delivered$/i,
    rto_initiated: /^(rto[\s_-]*initiated|rto_initiated|rto)$/i,
    rto_received: /^(rto[\s_-]*(received|delivered)|return[\s_-]*delivered|rto_received)$/i,
    canceled: /^cancell?ed$/i,
    lost: /^lost$/i,
  };
  return patterns[key] || new RegExp(`^${escapeRegex(status)}$`, "i");
}

function normalizeOrderName(orderName = "") {
  const value = String(orderName || "");
  return value.startsWith("#") ? value.slice(1) : value;
}

function normalizePhoneTail(value = "") {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function isCustomerSupportOperationsUser(user = {}) {
  return /^operations$/i.test(String(user.role || "").trim())
    && /^customer support$/i.test(String(user.department || "").trim());
}

async function resolveCustomerSupportOperationsEmployee(user = {}) {
  const roleDepartmentMatch = {
    role: /^operations$/i,
    department: /^customer support$/i,
  };
  const id = String(user._id || user.id || user.userId || "").trim();
  if (mongoose.Types.ObjectId.isValid(id)) {
    const employee = await Employee.findOne({ _id: id, ...roleDepartmentMatch }).select("_id hasTeam").lean();
    if (employee?._id) return employee;
  }

  const or = [];
  const email = String(user.email || "").trim();
  const fullName = String(user.fullName || user.name || "").trim();
  if (email) or.push({ email: new RegExp(`^${escapeRegex(email)}$`, "i") });
  if (fullName) or.push({ fullName: new RegExp(`^${escapeRegex(fullName)}$`, "i") });
  if (!or.length) return null;

  return Employee.findOne({ ...roleDepartmentMatch, $or: or }).select("_id hasTeam").lean();
}

function isClosedStatus(status = "") {
  return CLOSED_STATUS_KEYS.has(normalizeStatusKey(status));
}

function matchesStatusGroup(row, statusGroup) {
  if (statusGroup === "active") return !row.cancelledAt && !isClosedStatus(row.status);
  if (statusGroup === "closed") return Boolean(row.cancelledAt) || isClosedStatus(row.status);
  return true;
}

function matchesStatusKey(row, statusKey) {
  if (!statusKey) return true;
  return normalizeStatusKey(row.status) === statusKey;
}

function buildBaseMatch(query = {}) {
  const dateFrom = parseDateStart(query.date_from);
  const dateTo = parseDateEnd(query.date_to);
  const product = String(query.product || "").trim();
  const paymentMode = String(query.payment_mode || "").trim();

  const baseMatch = {};
  if (dateFrom || dateTo) {
    baseMatch.orderDate = {};
    if (dateFrom) baseMatch.orderDate.$gte = dateFrom;
    if (dateTo) baseMatch.orderDate.$lte = dateTo;
  }

  if (paymentMode) {
    const paymentRegex = new RegExp(`^${escapeRegex(paymentMode)}$`, "i");
    baseMatch.$or = [
      { modeOfPayment: paymentRegex },
      { paymentGatewayNames: paymentRegex },
    ];
  }

  if (product) {
    const productRegex = new RegExp(escapeRegex(product), "i");
    baseMatch.productsOrdered = {
      $elemMatch: {
        $or: [{ title: productRegex }, { sku: productRegex }],
      },
    };
  }

  return baseMatch;
}

function withActiveOrdersCutoff(baseMatch = {}) {
  const next = { ...baseMatch };
  const existingAnd = Array.isArray(next.$and) ? next.$and : [];
  const cutoffMatch = {
    $or: [
      { orderDate: { $gte: ACTIVE_ORDERS_START } },
      { orderDate: null, createdAt: { $gte: ACTIVE_ORDERS_START } },
    ],
  };

  next.$and = [...existingAnd, cutoffMatch];
  return next;
}

function hasActiveOrdersCutoff(baseMatch = {}) {
  const matches = Array.isArray(baseMatch?.$and) ? baseMatch.$and : [];
  return matches.some((item) =>
    Array.isArray(item?.$or) &&
    item.$or.some((condition) => {
      const start = condition?.orderDate?.$gte || condition?.createdAt?.$gte;
      return start instanceof Date && start.getTime() >= ACTIVE_ORDERS_START.getTime();
    })
  );
}

async function getStatusMapForOrders(orderNames = []) {
  const lookupIds = new Set();
  orderNames.forEach((orderName) => {
    const id = normalizeOrderName(orderName);
    if (!id) return;
    lookupIds.add(id);
    lookupIds.add(`#${id}`);
  });

  if (!lookupIds.size) return new Map();

  const statusRows = await Order.find({ order_id: { $in: Array.from(lookupIds) } })
    .select("order_id shipment_status tracking_number carrier_title last_updated_at updatedAt issue opsRemark")
    .sort({ last_updated_at: -1, updatedAt: -1, _id: -1 })
    .lean();

  const statusMap = new Map();
  statusRows.forEach((row) => {
    const key = normalizeOrderName(row.order_id);
    if (!key || statusMap.has(key)) return;
    statusMap.set(key, row);
  });
  return statusMap;
}

function toResponseRow(doc, statusMap) {
  const orderIdNoHash = normalizeOrderName(doc.orderName);
  const statusDoc = statusMap.get(orderIdNoHash) || {};
  const paymentMode = doc.modeOfPayment || doc.paymentGatewayNames?.[0] || "";

  return {
    id: String(doc._id),
    shopifyOrderId: doc.orderId,
    orderId: orderIdNoHash,
    orderName: doc.orderName,
    orderDate: doc.orderDate || doc.createdAt,
    customerName: doc.customerName || "",
    contactNumber: doc.contactNumber || "",
    customerAddress: doc.customerAddress || null,
    amount: doc.amount || 0,
    paymentMode,
    products: doc.productsOrdered || [],
    status: statusLabelFromKey(normalizeStatusKey(statusDoc.shipment_status)),
    statusRaw: statusDoc.shipment_status || "",
    trackingNumber: statusDoc.tracking_number || "",
    courier: statusDoc.carrier_title || "",
    statusUpdatedAt: statusDoc.last_updated_at,
    shipmentIssue: statusDoc.issue || "",
    opsRemark: statusDoc.opsRemark || "",
    financialStatus: doc.financial_status || "",
    fulfillmentStatus: doc.fulfillment_status || "",
    cancelledAt: doc.cancelled_at,
  };
}

async function getOrderMeta(baseMatch = {}) {
  const cacheKey = cacheKeyForMatch(baseMatch);
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < META_CACHE_TTL_MS) {
    return cached.value;
  }
  const activeCutoffApplied = hasActiveOrdersCutoff(baseMatch);

  const [shopifyTotal, cancelledCount, statusGroups] = await Promise.all([
    ShopifyOrder.countDocuments(baseMatch),
    ShopifyOrder.countDocuments({ ...baseMatch, cancelled_at: { $ne: null } }),
    Order.aggregate([
      { $group: { _id: "$shipment_status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const optionMap = new Map(BASE_STATUS_OPTIONS.map((item) => [item.value, { ...item }]));
  let trackedStatusCount = 0;
  let closedStatusCount = 0;

  statusGroups.forEach((item) => {
    const rawStatus = item._id || "";
    const count = Number(item.count || 0);
    const value = statusOptionValue(rawStatus);
    const label = value.startsWith("raw:") ? rawStatus : statusLabelFromValue(value);
    const existing = optionMap.get(value) || { value, label, count: 0 };
    existing.count += count;
    optionMap.set(value, existing);
    trackedStatusCount += count;
    if (isClosedStatus(rawStatus)) closedStatusCount += count;
  });

  const statusOptions = Array.from(optionMap.values())
    .filter((item) => item.count > 0 || BASE_STATUS_OPTIONS.some((base) => base.value === item.value))
    .sort((a, b) => {
      const aBase = BASE_STATUS_OPTIONS.findIndex((base) => base.value === a.value);
      const bBase = BASE_STATUS_OPTIONS.findIndex((base) => base.value === b.value);
      if (aBase !== -1 || bBase !== -1) return (aBase === -1 ? 999 : aBase) - (bBase === -1 ? 999 : bBase);
      return a.label.localeCompare(b.label);
    });

  const exactActiveCount = activeCutoffApplied
    ? await countOrdersByStatusGroup(baseMatch, "active")
    : null;
  const exactClosedCount = activeCutoffApplied
    ? Math.max(0, shopifyTotal - exactActiveCount)
    : null;

  const value = {
    counts: {
      all: shopifyTotal,
      active: activeCutoffApplied
        ? exactActiveCount
        : Math.max(0, shopifyTotal - cancelledCount - closedStatusCount),
      closed: activeCutoffApplied ? exactClosedCount : cancelledCount + closedStatusCount,
      trackedStatus: trackedStatusCount,
    },
    statusOptions,
  };
  metaCache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

async function updateOrderStatus(orderId, statusLabel) {
  const normalized = normalizeOrderName(orderId);
  if (!normalized) return null;

  const now = new Date();
  const update = {
    shipment_status: statusLabel,
    selfUpdated: true,
    last_updated_at: now,
  };
  const existing = await Order.findOneAndUpdate(
    { order_id: { $in: [normalized, `#${normalized}`] } },
    { $set: update },
    { new: true, sort: { last_updated_at: -1, updatedAt: -1, _id: -1 } }
  ).lean();

  if (existing) return existing;

  return Order.create({
    order_id: normalized,
    shipment_status: statusLabel,
    last_updated_at: now,
    selfUpdated: true,
  });
}

async function updateOrderRemark(orderId, opsRemark) {
  const normalized = normalizeOrderName(orderId);
  if (!normalized) return null;

  const now = new Date();
  const update = {
    opsRemark: String(opsRemark || "").trim(),
    last_updated_at: now,
  };
  const existing = await Order.findOneAndUpdate(
    { order_id: { $in: [normalized, `#${normalized}`] } },
    { $set: update },
    { new: true, sort: { last_updated_at: -1, updatedAt: -1, _id: -1 } }
  ).lean();

  if (existing) return existing;

  return Order.create({
    order_id: normalized,
    shipment_status: "Not Shipped",
    opsRemark: update.opsRemark,
    last_updated_at: now,
  });
}

async function updateOrderAgent(orderId, assignedAgentId) {
  const normalized = normalizeOrderName(orderId);
  if (!normalized) return null;

  const nextAgentId = assignedAgentId ? new mongoose.Types.ObjectId(String(assignedAgentId)) : null;
  const now = new Date();
  const update = {
    assignedAgentId: nextAgentId,
    last_updated_at: now,
  };
  const existing = await Order.findOneAndUpdate(
    { order_id: { $in: [normalized, `#${normalized}`] } },
    { $set: update },
    { new: true, sort: { last_updated_at: -1, updatedAt: -1, _id: -1 } }
  ).lean();

  if (existing) return existing;

  return Order.create({
    order_id: normalized,
    shipment_status: "Not Shipped",
    assignedAgentId: nextAgentId,
    last_updated_at: now,
  });
}

function buildStatusCounts(rows = []) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = row.status || "Not Shipped";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts, ([status, count]) => ({ status, count })).sort((a, b) =>
    a.status.localeCompare(b.status)
  );
}

async function countOrdersByStatusGroup(baseMatch = {}, statusGroup) {
  if (!statusGroup) return ShopifyOrder.countDocuments(baseMatch);

  const pipeline = [
    { $match: statusGroup === "active" ? { ...baseMatch, cancelled_at: null } : baseMatch },
    {
      $project: {
        orderName: 1,
        cancelled_at: 1,
      },
    },
    {
      $addFields: {
        orderIdNoHash: {
          $let: {
            vars: { on: { $toString: { $ifNull: ["$orderName", ""] } } },
            in: {
              $cond: [
                { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                "$$on",
              ],
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: "orders",
        let: {
          oid: "$orderIdNoHash",
          oidHash: { $concat: ["#", "$orderIdNoHash"] },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ["$order_id", "$$oid"] },
                  { $eq: ["$order_id", "$$oidHash"] },
                ],
              },
            },
          },
          { $sort: { last_updated_at: -1, updatedAt: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, shipment_status: 1 } },
        ],
        as: "statusOrder",
      },
    },
    {
      $addFields: {
        shipmentStatus: {
          $ifNull: [{ $arrayElemAt: ["$statusOrder.shipment_status", 0] }, "Not Available"],
        },
      },
    },
  ];

  pipeline.push(
    statusGroup === "active"
      ? {
          $match: {
            cancelled_at: null,
            shipmentStatus: { $not: CLOSED_STATUS_REGEX },
          },
        }
      : {
          $match: {
            $or: [
              { cancelled_at: { $ne: null } },
              { shipmentStatus: CLOSED_STATUS_REGEX },
            ],
          },
        }
  );
  pipeline.push({ $count: "count" });

  const [result] = await ShopifyOrder.aggregate(pipeline).allowDiskUse(true);
  return Number(result?.count || 0);
}

async function loadFastPage({ baseMatch, mode, page, limit, skip, sortDir, exactTotal }) {
  const sort = { orderDate: sortDir, createdAt: sortDir, _id: -1 };
  const statusGroup = mode === "closed" ? "closed" : mode === "all" ? null : "active";

  if (!statusGroup) {
    const [docs, total] = await Promise.all([
      ShopifyOrder.find(baseMatch).select(PAGE_SELECT).sort(sort).skip(skip).limit(limit).lean(),
      ShopifyOrder.countDocuments(baseMatch),
    ]);
    const statusMap = await getStatusMapForOrders(docs.map((doc) => doc.orderName));
    const rows = docs.map((doc) => toResponseRow(doc, statusMap));

    return {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statuses: buildStatusCounts(rows),
      data: rows,
    };
  }

  const targetCount = skip + limit;
  const rows = [];
  let rawSkip = 0;
  const scanMatch = statusGroup === "active" ? { ...baseMatch, cancelled_at: null } : baseMatch;
  const batchSize = Math.min(Math.max(limit * 5, 100), 500);
  const maxDocsToScan = Math.max(targetCount * 8, batchSize * 4);

  while (rows.length < targetCount && rawSkip < maxDocsToScan) {
    const docs = await ShopifyOrder.find(scanMatch)
      .select(PAGE_SELECT)
      .sort(sort)
      .skip(rawSkip)
      .limit(batchSize)
      .lean();

    if (!docs.length) break;

    const statusMap = await getStatusMapForOrders(docs.map((doc) => doc.orderName));
    docs.forEach((doc) => {
      const row = toResponseRow(doc, statusMap);
      if (matchesStatusGroup(row, statusGroup)) rows.push(row);
    });

    rawSkip += docs.length;
    if (docs.length < batchSize) break;
  }

  const pageRows = rows.slice(skip, skip + limit);
  const total = Number.isFinite(exactTotal) ? exactTotal : skip + pageRows.length;

  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    statuses: buildStatusCounts(pageRows),
    data: pageRows,
  };
}

router.get("/lms-orders/meta", requireSession, async (req, res) => {
  try {
    const meta = await getOrderMeta(buildBaseMatch(req.query));
    res.json(meta);
  } catch (err) {
    console.error("GET /api/lms-orders/meta error:", err);
    res.status(500).json({ error: "Failed to load LMS orders metadata" });
  }
});

router.patch("/lms-orders/status", requireSession, async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds
      : req.body?.orderId
        ? [req.body.orderId]
        : [];
    const statusValue = String(req.body?.status || "").trim();
    const statusLabel = statusLabelFromValue(statusValue);

    const uniqueOrderIds = [...new Set(orderIds.map(normalizeOrderName).filter(Boolean))].slice(0, 200);
    if (!uniqueOrderIds.length) {
      return res.status(400).json({ error: "At least one order ID is required." });
    }
    if (!statusValue || statusLabel === "All Statuses") {
      return res.status(400).json({ error: "Status is required." });
    }

    const updated = await Promise.all(uniqueOrderIds.map((orderId) => updateOrderStatus(orderId, statusLabel)));
    clearMetaCache();
    res.json({
      updated: updated.filter(Boolean).length,
      status: statusLabel,
    });
  } catch (err) {
    console.error("PATCH /api/lms-orders/status error:", err);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.patch("/lms-orders/remark", requireSession, async (req, res) => {
  try {
    const orderId = req.body?.orderId;
    const opsRemark = req.body?.opsRemark;
    const normalized = normalizeOrderName(orderId);

    if (!normalized) {
      return res.status(400).json({ error: "Order ID is required." });
    }

    const updated = await updateOrderRemark(normalized, opsRemark);
    res.json({
      orderId: normalized,
      opsRemark: updated?.opsRemark || "",
    });
  } catch (err) {
    console.error("PATCH /api/lms-orders/remark error:", err);
    res.status(500).json({ error: "Failed to update order remark" });
  }
});

router.patch("/lms-orders/agent", requireSession, async (req, res) => {
  try {
    const orderId = req.body?.orderId;
    const assignedAgentId = req.body?.assignedAgentId || null;
    const normalized = normalizeOrderName(orderId);

    if (!normalized) {
      return res.status(400).json({ error: "Order ID is required." });
    }

    let agent = null;
    if (assignedAgentId) {
      if (!mongoose.Types.ObjectId.isValid(String(assignedAgentId))) {
        return res.status(400).json({ error: "Invalid agent." });
      }

      agent = await Employee.findOne({
        _id: assignedAgentId,
        role: /^operations$/i,
        department: /^customer support$/i,
        status: /^active$/i,
      })
        .select("_id fullName")
        .lean();

      if (!agent) {
        return res.status(400).json({ error: "Select an active customer support operations agent." });
      }
    }

    const updated = await updateOrderAgent(normalized, assignedAgentId);
    res.json({
      orderId: normalized,
      assignedAgentId: updated?.assignedAgentId ? String(updated.assignedAgentId) : "",
      assignedAgentName: agent?.fullName || "",
    });
  } catch (err) {
    console.error("PATCH /api/lms-orders/agent error:", err);
    res.status(500).json({ error: "Failed to update order agent" });
  }
});

function parseDelayRange(value = "") {
  const key = String(value || "").trim();
  const ranges = {
    "7_10": [7, 10],
    "10_15": [10, 15],
    "15_20": [15, 20],
    "20_25": [20, 25],
    "25_plus": [26, null],
  };
  return ranges[key] || null;
}

function normalizeNdrLevel(value = "") {
  const level = String(value || "").trim().toLowerCase();
  if (level === "level2" || level === "level_2") return "level2";
  if (level === "closing") return "closing";
  return "level1";
}

function buildNdrPipeline(query = {}, section = "all", forFacet = true, assignedAgentScopeId = null) {
  const page = Math.max(parseInt(query.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(query.limit || "10", 10), 1), 100);
  const skip = (page - 1) * limit;
  const search = String(query.search || "").trim();
  const courier = String(query.courier || "").trim();
  const status = String(query.status || "").trim();
  const paymentMode = String(query.payment_mode || "").trim();
  const agent = String(query.agent || "").trim();
  const ndrLevel = normalizeNdrLevel(query.ndr_level);
  const delayRange = parseDelayRange(query.delay);
  const dateFrom = parseDateStart(query.date_from);
  const dateTo = parseDateEnd(query.date_to);
  const now = new Date();

  const pipeline = [];
  if (assignedAgentScopeId) {
    pipeline.push({
      $match: {
        assignedAgentId: new mongoose.Types.ObjectId(String(assignedAgentScopeId)),
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
              orderId: 1,
              orderName: 1,
              customerName: 1,
              contactNumber: 1,
              customerAddress: 1,
              orderDate: 1,
              createdAt: 1,
              amount: 1,
              modeOfPayment: 1,
              paymentGatewayNames: 1,
              productsOrdered: 1,
              cancelled_at: 1,
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
        customerNameEff: { $ifNull: ["$shop.customerName", { $ifNull: ["$full_name", ""] }] },
        phoneEff: { $ifNull: ["$shop.contactNumber", { $ifNull: ["$contact_number", ""] }] },
        paymentModeEff: {
          $ifNull: ["$shop.modeOfPayment", { $arrayElemAt: ["$shop.paymentGatewayNames", 0] }],
        },
        delayDays: {
          $floor: {
            $divide: [{ $subtract: [now, { $ifNull: ["$shop.orderDate", { $ifNull: ["$order_date", now] }] }] }, 86400000],
          },
        },
      },
    },
    {
      $match: {
        "shop.productsOrdered": {
          $not: {
            $elemMatch: {
              title: NDR_EXCLUDED_PRODUCT_REGEX,
            },
          },
        },
      },
    },
    {
      $match: {
        $or: [{ "shop.cancelled_at": null }, { "shop.cancelled_at": { $exists: false } }],
      },
    },
  );

  if (ndrLevel === "closing") {
    pipeline.push({ $match: { shipment_status: NDR_CLOSING_STATUS_REGEX } });
  } else {
    pipeline.push({ $match: { shipment_status: { $not: NDR_CLOSING_STATUS_REGEX } } });
    if (ndrLevel === "level2") {
      pipeline.push({ $match: { opsRemark: { $exists: true, $nin: ["", null] } } });
    }
  }

  if (dateFrom || dateTo) {
    const dateMatch = {};
    if (dateFrom) dateMatch.$gte = dateFrom;
    if (dateTo) dateMatch.$lte = dateTo;
    pipeline.push({ $match: { orderDateEff: dateMatch } });
  }

  if (courier) pipeline.push({ $match: { carrier_title: new RegExp(escapeRegex(courier), "i") } });
  if (status) pipeline.push({ $match: { shipment_status: statusRegexForKey(status) } });
  if (paymentMode) pipeline.push({ $match: { paymentModeEff: new RegExp(`^${escapeRegex(paymentMode)}$`, "i") } });
  if (agent === "no_agent") {
    pipeline.push({
      $match: {
        $or: [
          { assignedAgentId: null },
          { assignedAgentId: { $exists: false } },
        ],
      },
    });
  } else if (agent && mongoose.Types.ObjectId.isValid(agent)) {
    pipeline.push({ $match: { assignedAgentId: new mongoose.Types.ObjectId(agent) } });
  }
  if (delayRange) {
    const [min, max] = delayRange;
    pipeline.push({ $match: { delayDays: max ? { $gte: min, $lte: max } : { $gte: min } } });
  }
  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    pipeline.push({
      $match: {
        $or: [
          { order_id: searchRegex },
          { customerNameEff: searchRegex },
          { phoneEff: searchRegex },
          { tracking_number: searchRegex },
          { carrier_title: searchRegex },
          { "shop.productsOrdered.title": searchRegex },
          { "shop.productsOrdered.sku": searchRegex },
        ],
      },
    });
  }

  const projectRow = {
    _id: 0,
    id: { $toString: "$_id" },
    orderId: "$orderIdNoHash",
    orderName: { $ifNull: ["$shop.orderName", "$order_id"] },
    orderDate: "$orderDateEff",
    customerName: "$customerNameEff",
    contactNumber: "$phoneEff",
    customerAddress: { $ifNull: ["$shop.customerAddress", null] },
    amount: { $ifNull: ["$shop.amount", 0] },
    paymentMode: { $ifNull: ["$paymentModeEff", ""] },
    products: { $ifNull: ["$shop.productsOrdered", []] },
    status: "$shipment_status",
    statusRaw: "$shipment_status",
    trackingNumber: { $ifNull: ["$tracking_number", ""] },
    courier: { $ifNull: ["$carrier_title", ""] },
    statusUpdatedAt: "$last_updated_at",
    opsRemark: { $ifNull: ["$opsRemark", ""] },
    assignedAgentId: { $ifNull: [{ $toString: "$assignedAgentId" }, ""] },
    delayDays: 1,
    section: { $literal: section },
  };

  if (!forFacet) return pipeline;

  pipeline.push({
    $facet: {
      rows: [
        { $sort: { orderDateEff: -1, last_updated_at: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: projectRow },
      ],
      total: [{ $count: "count" }],
      statuses: [
        { $group: { _id: "$shipment_status", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
      carriers: [
        { $group: { _id: "$carrier_title" } },
        { $sort: { _id: 1 } },
      ],
      payments: [
        { $group: { _id: "$paymentModeEff", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
    },
  });
  return pipeline;
}

router.get("/lms-orders/ndr", requireSession, async (req, res) => {
  try {
    const section = "all";
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 100);
    let assignedAgentScopeId = null;
    if (isCustomerSupportOperationsUser(req.sessionUser || {})) {
      const employee = await resolveCustomerSupportOperationsEmployee(req.sessionUser || {});
      if (!employee?._id) {
        return res.json({
          section,
          page,
          limit,
          total: 0,
          totalPages: 1,
          statusOptions: [],
          paymentOptions: [],
          carriers: [],
          data: [],
        });
      }
      if (!employee.hasTeam) assignedAgentScopeId = employee._id;
    }

    const [result] = await Order.aggregate(buildNdrPipeline(req.query, section, true, assignedAgentScopeId)).allowDiskUse(true);
    const total = result?.total?.[0]?.count || 0;
    const statusMap = new Map();
    (result?.statuses || []).forEach((item) => {
      const label = String(item._id || "Not Available").trim() || "Not Available";
      const value = `raw:${label}`;
      const existing = statusMap.get(value) || { value, label, count: 0 };
      existing.count += Number(item.count || 0);
      statusMap.set(value, existing);
    });

    res.json({
      section,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statusOptions: Array.from(statusMap.values()).filter((item) => item.count > 0),
      paymentOptions: (result?.payments || [])
        .map((item) => ({
          value: String(item._id || "").trim(),
          label: String(item._id || "Not Available").trim() || "Not Available",
          count: Number(item.count || 0),
        }))
        .filter((item) => item.value && item.count > 0),
      carriers: (result?.carriers || []).map((item) => item._id).filter(Boolean),
      data: result?.rows || [],
    });
  } catch (err) {
    console.error("GET /api/lms-orders/ndr error:", err);
    res.status(500).json({ error: "Failed to load NDR orders" });
  }
});

router.get("/lms-orders", requireSession, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const skip = (page - 1) * limit;

    const requestedMode = String(req.query.mode || "active").toLowerCase() === "all" ? "all" : "active";
    const statusGroup = String(req.query.status_group || "").toLowerCase();
    const mode =
      requestedMode === "active"
        ? "active"
        : statusGroup === "active" || statusGroup === "closed"
          ? statusGroup
          : "all";
    const search = String(req.query.search || "").trim();
    const courier = String(req.query.courier || "").trim();
    const status = String(req.query.status || "").trim();
    const sortField = "orderDateEff";
    const sortDir = -1;

    const baseMatchRaw = buildBaseMatch(req.query);
    const baseMatch = mode === "active" ? withActiveOrdersCutoff(baseMatchRaw) : baseMatchRaw;

    const canUseFastPath = !search && !courier && !status && sortField === "orderDateEff";
    if (canUseFastPath) {
      const meta = await getOrderMeta(baseMatch);
      const exactTotal =
        mode === "active"
          ? meta.counts.active
          : mode === "closed"
            ? meta.counts.closed
            : meta.counts.all;
      const result = await loadFastPage({ baseMatch, mode, page, limit, skip, sortDir, exactTotal });
      return res.json({ ...result, ...meta });
    }

    const pipeline = [
      { $match: baseMatch },
      {
        $project: {
          orderId: 1,
          orderName: 1,
          customerName: 1,
          contactNumber: 1,
          customerAddress: 1,
          orderDate: 1,
          createdAt: 1,
          amount: 1,
          modeOfPayment: 1,
          paymentGatewayNames: 1,
          productsOrdered: 1,
          financial_status: 1,
          fulfillment_status: 1,
          cancelled_at: 1,
        },
      },
      {
        $addFields: {
          orderDateEff: { $ifNull: ["$orderDate", "$createdAt"] },
          paymentModeEff: {
            $ifNull: ["$modeOfPayment", { $arrayElemAt: ["$paymentGatewayNames", 0] }],
          },
          orderIdNoHash: {
            $let: {
              vars: { on: { $toString: { $ifNull: ["$orderName", ""] } } },
              in: {
                $cond: [
                  { $eq: [{ $substrCP: ["$$on", 0, 1] }, "#"] },
                  { $substrCP: ["$$on", 1, { $subtract: [{ $strLenCP: "$$on" }, 1] }] },
                  "$$on",
                ],
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: "orders",
          let: {
            oid: "$orderIdNoHash",
            oidHash: { $concat: ["#", "$orderIdNoHash"] },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$order_id", "$$oid"] },
                    { $eq: ["$order_id", "$$oidHash"] },
                  ],
                },
              },
            },
            { $sort: { last_updated_at: -1, updatedAt: -1, _id: -1 } },
            { $limit: 1 },
            {
              $project: {
                _id: 0,
                shipment_status: 1,
                tracking_number: 1,
                carrier_title: 1,
                last_updated_at: 1,
                issue: 1,
                opsRemark: 1,
              },
            },
          ],
          as: "statusOrder",
        },
      },
      {
        $addFields: {
          statusDoc: { $arrayElemAt: ["$statusOrder", 0] },
          shipmentStatus: {
            $ifNull: [{ $arrayElemAt: ["$statusOrder.shipment_status", 0] }, "Not Available"],
          },
          trackingNumber: { $arrayElemAt: ["$statusOrder.tracking_number", 0] },
          carrierTitle: { $arrayElemAt: ["$statusOrder.carrier_title", 0] },
          statusUpdatedAt: { $arrayElemAt: ["$statusOrder.last_updated_at", 0] },
          shipmentIssue: { $arrayElemAt: ["$statusOrder.issue", 0] },
          opsRemark: { $arrayElemAt: ["$statusOrder.opsRemark", 0] },
        },
      },
    ];

    if (mode === "active" || mode === "closed") {
      pipeline.push(
        mode === "active"
          ? {
              $match: {
                cancelled_at: null,
                shipmentStatus: { $not: CLOSED_STATUS_REGEX },
              },
            }
          : {
              $match: {
                $or: [
                  { cancelled_at: { $ne: null } },
                  { shipmentStatus: CLOSED_STATUS_REGEX },
                ],
              },
            }
      );
    }

    if (status) {
      pipeline.push({
        $match: { shipmentStatus: statusRegexForKey(status) },
      });
    }

    if (courier) {
      pipeline.push({
        $match: {
          carrierTitle: new RegExp(escapeRegex(courier), "i"),
        },
      });
    }

    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), "i");
      pipeline.push({
        $match: {
          $or: [
            { orderName: searchRegex },
            { customerName: searchRegex },
            { contactNumber: searchRegex },
            { "customerAddress.phone": searchRegex },
            { trackingNumber: searchRegex },
            { carrierTitle: searchRegex },
            { shipmentStatus: searchRegex },
            { "productsOrdered.title": searchRegex },
            { "productsOrdered.sku": searchRegex },
          ],
        },
      });
    }

    pipeline.push({
      $facet: {
        rows: [
          { $sort: { [sortField]: sortDir, _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: { $toString: "$_id" },
              shopifyOrderId: "$orderId",
              orderId: "$orderIdNoHash",
              orderName: 1,
              orderDate: "$orderDateEff",
              customerName: { $ifNull: ["$customerName", ""] },
              contactNumber: { $ifNull: ["$contactNumber", ""] },
              customerAddress: { $ifNull: ["$customerAddress", null] },
              amount: { $ifNull: ["$amount", 0] },
              paymentMode: { $ifNull: ["$paymentModeEff", ""] },
              products: { $ifNull: ["$productsOrdered", []] },
              status: "$shipmentStatus",
              statusRaw: "$shipmentStatus",
              trackingNumber: { $ifNull: ["$trackingNumber", ""] },
              courier: { $ifNull: ["$carrierTitle", ""] },
              statusUpdatedAt: 1,
              shipmentIssue: { $ifNull: ["$shipmentIssue", ""] },
              opsRemark: { $ifNull: ["$opsRemark", ""] },
              financialStatus: { $ifNull: ["$financial_status", ""] },
              fulfillmentStatus: { $ifNull: ["$fulfillment_status", ""] },
              cancelledAt: "$cancelled_at",
            },
          },
        ],
        total: [{ $count: "count" }],
        statuses: [
          { $group: { _id: "$shipmentStatus", count: { $sum: 1 } } },
          { $project: { _id: 0, status: "$_id", count: 1 } },
          { $sort: { status: 1 } },
        ],
      },
    });

    pipeline.push({
      $project: {
        rows: 1,
        statuses: 1,
        total: { $ifNull: [{ $arrayElemAt: ["$total.count", 0] }, 0] },
      },
    });

    const [result] = await ShopifyOrder.aggregate(pipeline).allowDiskUse(true);
    const total = result?.total || 0;

    const meta = await getOrderMeta(baseMatch);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      statuses: result?.statuses || [],
      statusOptions: meta.statusOptions,
      counts: meta.counts,
      data: result?.rows || [],
    });
  } catch (err) {
    console.error("GET /api/lms-orders error:", err);
    res.status(500).json({ error: "Failed to load LMS orders" });
  }
});

module.exports = router;
