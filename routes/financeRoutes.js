const express = require("express");
const router = express.Router();
const axios = require("axios");

// Base data models
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder");
const ShopifyFinanceOrder = require("../models/ShopifyFinanceOrder");

// Settlement / payment models
const EasebuzzTransaction = require("../models/EasebuzzTransaction");
const DtdcSettlement = require("../models/DtdcSettlement");
const DelhiverySettlement = require("../models/DelhiverySettlement");
const BluedartSettlement = require("../models/BluedartSettlement");

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;

function monthRangeUTC({ year, month }) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

function shopifyOrdersBaseUrl({ start, end }) {
  let baseUrl =
    `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-07/orders.json` +
    `?status=any&limit=250` +
    `&fields=id,name,created_at,financial_status,gateway,payment_gateway_names,customer,billing_address,note_attributes,total_price,archived,cancelled_at`;
  if (start) baseUrl += `&created_at_min=${start.toISOString()}`;
  if (end) baseUrl += `&created_at_max=${end.toISOString()}`;
  return baseUrl;
}

async function fetchShopifyOrdersMinimal(start, end) {
  const out = [];
  let nextUrl = shopifyOrdersBaseUrl({ start, end });

  try {
    while (nextUrl) {
      const res = await axios.get(nextUrl, {
        headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN },
      });

      const batch = res?.data?.orders || [];
      out.push(...batch);

      const linkHeader = res.headers?.link;
      const nextLink = linkHeader
        ?.split(",")
        ?.find((s) => s.includes('rel="next"'));
      if (nextLink) {
        const m = nextLink.match(/<([^>]+)>/);
        nextUrl = m?.[1] || null;
      } else {
        nextUrl = null;
      }
    }
  } catch (err) {
    if (err.response?.status === 429) {
      console.error("Shopify API rate limit hit (429)");
    } else {
      console.error("Error fetching Shopify orders:", err.message);
    }
  }
  return out;
}

function mapShopifyToSnapshot(o) {
  const billingName =
    o?.customer?.first_name && o?.customer?.last_name
      ? `${o.customer.first_name} ${o.customer.last_name}`.trim()
      : o?.customer?.first_name || o?.billing_address?.name || "Unknown";

  const phone = o?.customer?.phone || o?.billing_address?.phone || "";

  const paymentMethod =
    o?.payment_gateway_names?.[0] || o?.gateway || "";

  const lmsNote =
    (Array.isArray(o?.note_attributes)
      ? o.note_attributes.find((a) => a?.name === "transaction_id")?.value
      : "") || "";

  // 🔴 Shopify order created_at (true order date)
  const shopifyCreated = o?.created_at ? new Date(o.created_at) : new Date();

  return {
    orderName: o?.name || "",

    // 🔴 Use this for filtering + showing in UI
    orderDate: shopifyCreated,

    // keep createdAt also (can be same)
    createdAt: shopifyCreated,

    billingName,
    phone,
    financialStatus: o?.financial_status || "",
    paymentMethod,
    totalPrice: parseFloat(o?.total_price || 0),
    lmsNote,
    shopifyId: o?.id,
  };
}

function normalizeOrderNameToId(orderName) {
  return (orderName || "").toString().replace(/^#/, "").trim();
}

// Build robust match sets (raw "#1234", clean "1234", numeric 1234)
function buildMatchSets(orderNames) {
  const raw = new Set();
  const clean = new Set();
  const numeric = new Set();

  for (const on of orderNames) {
    const rawKey = (on || "").toString().trim();
    const cleanKey = normalizeOrderNameToId(rawKey);

    if (rawKey) raw.add(rawKey);
    if (cleanKey) clean.add(cleanKey);

    const n = Number(cleanKey);
    if (!Number.isNaN(n) && Number.isFinite(n) && String(n) === cleanKey) {
      numeric.add(n);
    }
  }
  return { raw: [...raw], clean: [...clean], numeric: [...numeric] };
}

/** Normalize Date -> "YYYY-MM-DD" */
function toISODateString(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse mixed settlement date formats to "YYYY-MM-DD" */
function parseSettlementDateString(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;

  // Native Date first
  const d1 = new Date(str);
  if (!isNaN(d1.getTime())) return toISODateString(d1);

  // DD-MMM-YY
  let m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monStr = m[2].toLowerCase();
    const yy = parseInt(m[3], 10);
    const monMap = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const month = monMap[monStr];
    if (month !== undefined) {
      const year = 2000 + yy;
      const date = new Date(Date.UTC(year, month, day));
      return toISODateString(date);
    }
  }

  // DD-MM-YYYY
  m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const date = new Date(Date.UTC(year, month, day));
    return toISODateString(date);
  }

  const tryIso = new Date(str.replace(" ", "T"));
  if (!isNaN(tryIso.getTime())) return toISODateString(tryIso);

  return null;
}

/**
 * 🔁 Incremental refresh (used by frontend Refresh button)
 */
router.post("/refresh-shopify", async (req, res) => {
  try {
    const lastDoc = await ShopifyFinanceOrder.findOne()
      .sort({ orderDate: -1 }) // use orderDate if available
      .lean();

    let start;
    let isInitialBackfill = false;

    if (lastDoc?.orderDate || lastDoc?.createdAt) {
      start = new Date(lastDoc.orderDate || lastDoc.createdAt);
    } else {
      start = new Date(Date.UTC(2025, 3, 1, 0, 0, 0, 0)); // 2025-04-01
      isInitialBackfill = true;
    }

    const end = new Date();

    const shopifyOrders = await fetchShopifyOrdersMinimal(start, end);

    const filtered = shopifyOrders.filter((o) => {
      const isVoided = (o?.financial_status || "").toLowerCase() === "voided";
      const isArchived = !!o?.archived;
      const isCancelled = !!o?.cancelled_at;
      return !isVoided && !isArchived && !isCancelled;
    });

    const ops = filtered.map((o) => {
      const snap = mapShopifyToSnapshot(o);
      return {
        updateOne: {
          filter: { orderName: snap.orderName },
          update: { $set: snap },
          upsert: true,
        },
      };
    });

    if (ops.length) {
      const result = await ShopifyFinanceOrder.bulkWrite(ops, {
        ordered: false,
      });
      return res.status(200).json({
        ok: true,
        mode: "incremental",
        isInitialBackfill,
        start: start.toISOString(),
        end: end.toISOString(),
        fetched: shopifyOrders.length,
        saved: filtered.length,
        skipped: shopifyOrders.length - filtered.length,
        upserted: result.upsertedCount || 0,
        modified: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
      });
    } else {
      return res.status(200).json({
        ok: true,
        mode: "incremental",
        isInitialBackfill,
        start: start.toISOString(),
        end: end.toISOString(),
        fetched: shopifyOrders.length,
        saved: 0,
        skipped: shopifyOrders.length,
        upserted: 0,
        modified: 0,
        matched: 0,
      });
    }
  } catch (err) {
    console.error("refresh-shopify error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to refresh from Shopify" });
  }
});

/**
 * 🧨 FULL BACKFILL / RANGE REFRESH (for Postman)
 */
router.post("/refresh-shopify-full", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;

    // Default start = 1 April 2025
    let start = startDate
      ? new Date(`${startDate}T00:00:00.000Z`)
      : new Date(Date.UTC(2025, 3, 1, 0, 0, 0, 0));

    // Default end = now
    let end = endDate
      ? new Date(`${endDate}T23:59:59.999Z`)
      : new Date();

    const shopifyOrders = await fetchShopifyOrdersMinimal(start, end);

    const filtered = shopifyOrders.filter((o) => {
      const isVoided = (o?.financial_status || "").toLowerCase() === "voided";
      const isArchived = !!o?.archived;
      const isCancelled = !!o?.cancelled_at;
      return !isVoided && !isArchived && !isCancelled;
    });

    const ops = filtered.map((o) => {
      const snap = mapShopifyToSnapshot(o);
      return {
        updateOne: {
          filter: { orderName: snap.orderName },
          update: { $set: snap },
          upsert: true,
        },
      };
    });

    if (ops.length) {
      const result = await ShopifyFinanceOrder.bulkWrite(ops, {
        ordered: false,
      });
      return res.status(200).json({
        ok: true,
        mode: "full-range",
        rangeStart: start.toISOString(),
        rangeEnd: end.toISOString(),
        fetched: shopifyOrders.length,
        saved: filtered.length,
        skipped: shopifyOrders.length - filtered.length,
        upserted: result.upsertedCount || 0,
        modified: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
      });
    } else {
      return res.status(200).json({
        ok: true,
        mode: "full-range",
        rangeStart: start.toISOString(),
        rangeEnd: end.toISOString(),
        fetched: shopifyOrders.length,
        saved: 0,
        skipped: shopifyOrders.length,
        upserted: 0,
        modified: 0,
        matched: 0,
      });
    }
  } catch (err) {
    console.error("refresh-shopify-full error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to full-refresh from Shopify" });
  }
});

/**
 * 📄 Paged + filtered list for frontend
 * - Expects startDate / endDate as "YYYY-MM-DD" (or empty)
 * - Filters by orderDate (Shopify order date)
 */
router.get("/orders", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200
    );
    const skip = (page - 1) * limit;

    const { startDate, endDate } = req.query;
    const findQuery = { financialStatus: { $ne: "voided" } };

    if (startDate || endDate) {
      const orderDate = {};
      if (startDate) {
        orderDate.$gte = new Date(`${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        orderDate.$lte = new Date(`${endDate}T23:59:59.999Z`);
      }
      findQuery.orderDate = orderDate;
    }

    const [totalCount, baseRows] = await Promise.all([
      ShopifyFinanceOrder.countDocuments(findQuery),
      ShopifyFinanceOrder.find(findQuery)
        .sort({ orderDate: -1 }) // 🔴 sort by orderDate (reverse chronological)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    if (baseRows.length === 0) {
      return res.status(200).json({ orders: [], totalCount });
    }

    const orderNames = baseRows.map((r) => r.orderName).filter(Boolean);
    const {
      raw: rawKeys,
      clean: cleanKeys,
      numeric: numericKeys,
    } = buildMatchSets(orderNames);

    // 1) Order (includes shipment_status)
    const ordersDocs = await Order.find({ order_id: { $in: cleanKeys } })
      .select(
        "order_id tracking_number carrier_title last_updated_at shipment_status"
      )
      .lean();

    // 2) MyOrder
    const myOrdersStrDocs = await MyOrder.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId partialPayment")
      .lean();
    let myOrdersNumDocs = [];
    if (numericKeys.length) {
      myOrdersNumDocs = await MyOrder.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId partialPayment")
        .lean();
    }

    // 3) Settlements
    const easebuzzStrDocs = await EasebuzzTransaction.find({
      merchantOrderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("merchantOrderId settlementUTR amount settlementDate")
      .lean();
    let easebuzzNumDocs = [];
    if (numericKeys.length) {
      easebuzzNumDocs = await EasebuzzTransaction.find({
        merchantOrderId: { $in: numericKeys },
      })
        .select("merchantOrderId settlementUTR amount settlementDate")
        .lean();
    }

    const dtdcStrDocs = await DtdcSettlement.find({
      customerReferenceNumber: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("customerReferenceNumber utrNumber codAmount remittanceDate")
      .lean();
    let dtdcNumDocs = [];
    if (numericKeys.length) {
      dtdcNumDocs = await DtdcSettlement.find({
        customerReferenceNumber: { $in: numericKeys },
      })
        .select("customerReferenceNumber utrNumber codAmount remittanceDate")
        .lean();
    }

    const delhiveryStrDocs = await DelhiverySettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utrNo amount settledDate")
      .lean();
    let delhiveryNumDocs = [];
    if (numericKeys.length) {
      delhiveryNumDocs = await DelhiverySettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utrNo amount settledDate")
        .lean();
    }

    const bluedartStrDocs = await BluedartSettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utr customerPayAmt settledDate")
      .lean();
    let bluedartNumDocs = [];
    if (numericKeys.length) {
      bluedartNumDocs = await BluedartSettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utr customerPayAmt settledDate")
        .lean();
    }

    // Maps
    const mapOrderByCleanId = new Map();
    for (const od of ordersDocs) {
      mapOrderByCleanId.set((od.order_id || "").toString(), od);
    }

    const mapMyOrderByAnyId = new Map();
    const indexMyOrder = (mo) => {
      const raw = (mo.orderId ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const num = Number.isFinite(Number(raw)) ? Number(raw) : null;
      if (raw) mapMyOrderByAnyId.set(raw, mo);
      if (clean) mapMyOrderByAnyId.set(clean, mo);
      if (num !== null) mapMyOrderByAnyId.set(num, mo);
    };
    [...myOrdersStrDocs, ...myOrdersNumDocs].forEach(indexMyOrder);

    const mapUtrByKey = new Map();
    const mapAmountByKey = new Map();
    const mapSettleDateByKey = new Map();

    const addAmount = (key, amt) => {
      if (key === undefined || key === null) return;
      const n = Number(amt);
      if (Number.isNaN(n)) return;
      mapAmountByKey.set(key, (mapAmountByKey.get(key) || 0) + n);
    };

    const setUtrPriority = (key, utr) => {
      const u = (utr || "").toString().trim();
      if (!key || !u) return;
      if (!mapUtrByKey.has(key)) mapUtrByKey.set(key, u);
    };

    const setDatePriority = (key, dateStr) => {
      const iso = parseSettlementDateString(dateStr);
      if (!key || !iso) return;
      if (!mapSettleDateByKey.has(key)) mapSettleDateByKey.set(key, iso);
    };

    for (const ez of [...easebuzzStrDocs, ...easebuzzNumDocs]) {
      const raw = (ez.merchantOrderId ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const num = Number.isFinite(Number(raw)) ? Number(raw) : null;

      setUtrPriority(raw, ez.settlementUTR);
      setUtrPriority(clean, ez.settlementUTR);
      if (num !== null) setUtrPriority(num, ez.settlementUTR);

      setDatePriority(raw, ez.settlementDate);
      setDatePriority(clean, ez.settlementDate);
      if (num !== null) setDatePriority(num, ez.settlementDate);

      addAmount(raw, ez.amount);
      addAmount(clean, ez.amount);
      if (num !== null) addAmount(num, ez.amount);
    }

    for (const d of [...dtdcStrDocs, ...dtdcNumDocs]) {
      const raw = (d.customerReferenceNumber ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const num = Number.isFinite(Number(raw)) ? Number(raw) : null;

      setUtrPriority(raw, d.utrNumber);
      setUtrPriority(clean, d.utrNumber);
      if (num !== null) setUtrPriority(num, d.utrNumber);

      setDatePriority(raw, d.remittanceDate);
      setDatePriority(clean, d.remittanceDate);
      if (num !== null) setDatePriority(num, d.remittanceDate);

      addAmount(raw, d.codAmount);
      addAmount(clean, d.codAmount);
      if (num !== null) addAmount(num, d.codAmount);
    }

    for (const dl of [...delhiveryStrDocs, ...delhiveryNumDocs]) {
      const raw = (dl.orderId ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const num = Number.isFinite(Number(raw)) ? Number(raw) : null;

      setUtrPriority(raw, dl.utrNo);
      setUtrPriority(clean, dl.utrNo);
      if (num !== null) setUtrPriority(num, dl.utrNo);

      setDatePriority(raw, dl.settledDate);
      setDatePriority(clean, dl.settledDate);
      if (num !== null) setDatePriority(num, dl.settledDate);

      addAmount(raw, dl.amount);
      addAmount(clean, dl.amount);
      if (num !== null) addAmount(num, dl.amount);
    }

    for (const bd of [...bluedartStrDocs, ...bluedartNumDocs]) {
      const raw = (bd.orderId ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const num = Number.isFinite(Number(raw)) ? Number(raw) : null;

      setUtrPriority(raw, bd.utr);
      setUtrPriority(clean, bd.utr);
      if (num !== null) setUtrPriority(num, bd.utr);

      setDatePriority(raw, bd.settledDate);
      setDatePriority(clean, bd.settledDate);
      if (num !== null) setDatePriority(num, bd.settledDate);

      addAmount(raw, bd.customerPayAmt);
      addAmount(clean, bd.customerPayAmt);
      if (num !== null) addAmount(num, bd.customerPayAmt);
    }

    const rows = baseRows.map((r) => {
      const cleanId = normalizeOrderNameToId(r.orderName);
      const numericId = Number.isFinite(Number(cleanId))
        ? Number(cleanId)
        : null;

      const od = mapOrderByCleanId.get(cleanId);
      const mo =
        mapMyOrderByAnyId.get(r.orderName) ||
        mapMyOrderByAnyId.get(cleanId) ||
        (numericId !== null ? mapMyOrderByAnyId.get(numericId) : undefined);

      const trackingId = od?.tracking_number || "--";
      const courierPartner = od?.carrier_title || "--";
      const deliveredDate = od?.last_updated_at || null;

      // Shipment status from Orders collection
      const shipmentStatus = od?.shipment_status || "—";

      const partialPayment =
        typeof mo?.partialPayment === "number" ? mo.partialPayment : 0;

      const utr =
        mapUtrByKey.get(r.orderName) ??
        mapUtrByKey.get(cleanId) ??
        (numericId !== null ? mapUtrByKey.get(numericId) : undefined) ??
        "";

      const settlementDate =
        mapSettleDateByKey.get(r.orderName) ??
        mapSettleDateByKey.get(cleanId) ??
        (numericId !== null ? mapSettleDateByKey.get(numericId) : undefined) ??
        "";

      const totalReceived =
        (mapAmountByKey.get(r.orderName) ?? 0) +
        (mapAmountByKey.get(cleanId) ?? 0) +
        (numericId !== null ? mapAmountByKey.get(numericId) ?? 0 : 0);

      // Remaining = max(0, Partial Payment - Total Received)
      const remainingAmount =
        partialPayment > 0 ? Math.max(0, partialPayment - totalReceived) : 0;

      // 🔒 Auto-close logic
      // 1) If shipmentStatus is "RTO Delivered" → closed
      // 2) If UTR exists AND shipmentStatus is "Delivered" AND remainingAmount == 0 → closed
      let customOrderStatus = "open";

      if (shipmentStatus === "RTO Delivered") {
        customOrderStatus = "closed";
      }

      if (utr && shipmentStatus === "Delivered" && remainingAmount === 0) {
        customOrderStatus = "closed";
      }

      return {
        // 🔴 frontend can use this for date column
        orderDate: r.orderDate,
        createdAt: r.createdAt,

        orderName: r.orderName,
        billingName: r.billingName,
        phone: r.phone,
        financialStatus: r.financialStatus,
        paymentMethod: r.paymentMethod,
        totalPrice: r.totalPrice,
        lmsNote: r.lmsNote,

        trackingId,
        courierPartner,
        shipmentStatus,
        customOrderStatus,
        partialPayment,

        deliveredDate,
        totalReceived,
        remainingAmount,

        refund: "",
        settlementDate, // "YYYY-MM-DD"
        remark: "",
        utr,
        orderStatus: "—",
      };
    });

    return res.status(200).json({ orders: rows, totalCount });
  } catch (err) {
    console.error("Error in GET /api/finance/orders:", err);
    return res.status(500).json({ error: "Failed to fetch orders from DB" });
  }
});

module.exports = router;
