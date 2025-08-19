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

/* -------------------- Helpers -------------------- */

function monthRangeUTC({ year, month }) {
  // month: 1-12
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)); // last day of month
  return { start, end };
}

function shopifyOrdersBaseUrl({ start, end }) {
  // include archived + cancelled fields so we can skip them
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
      const nextLink = linkHeader?.split(",")?.find((s) => s.includes('rel="next"'));
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
      : o?.customer?.first_name ||
        o?.billing_address?.name ||
        "Unknown";

  const phone =
    o?.customer?.phone ||
    o?.billing_address?.phone ||
    "";

  const paymentMethod =
    o?.payment_gateway_names?.[0] ||
    o?.gateway ||
    "";

  const lmsNote =
    (Array.isArray(o?.note_attributes)
      ? o.note_attributes.find((a) => a?.name === "transaction_id")?.value
      : "") || "";

  return {
    orderName: o?.name || "",
    createdAt: o?.created_at ? new Date(o.created_at) : new Date(),
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
  // "#12345" -> "12345"; also trim spaces
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

/* -------------------- Routes -------------------- */

/**
 * POST /api/finance/refresh-shopify
 * Pull July data (default July 2025) and upsert into ShopifyFinanceOrder
 * Optional query: ?year=2025&month=7
 *
 * Excludes: financial_status = "voided", archived = true, cancelled orders.
 */
router.post("/refresh-shopify", async (req, res) => {
  try {
    const year = parseInt(req.query.year || "2025", 10);
    const month = parseInt(req.query.month || "7", 10); // July = 7

    const { start, end } = monthRangeUTC({ year, month });

    const shopifyOrders = await fetchShopifyOrdersMinimal(start, end);

    // filter out voided / archived / cancelled
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
      const result = await ShopifyFinanceOrder.bulkWrite(ops, { ordered: false });
      return res.status(200).json({
        ok: true,
        year,
        month,
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
        year,
        month,
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
    return res.status(500).json({ ok: false, error: "Failed to refresh from Shopify" });
  }
});

/**
 * GET /api/finance/orders
 * Read from DB snapshot and enrich with:
 * - Courier Partner, Order Tracking ID, Delivered Date (last_updated_at) from Order
 * - Partial Payment from MyOrder
 * - Settlement UTR + Total Received from Easebuzz/DTDC/Delhivery/Bluedart (robust match)
 * - Remaining = Total Received - Partial Payment
 *
 * Also excludes stale "voided" rows if any exist in DB from earlier runs.
 */
router.get("/orders", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);
    const skip = (page - 1) * limit;

    const { startDate, endDate } = req.query;
    const findQuery = {
      financialStatus: { $ne: "voided" },
    };

    if (startDate || endDate) {
      findQuery.createdAt = {};
      if (startDate) findQuery.createdAt.$gte = new Date(startDate);
      if (endDate) findQuery.createdAt.$lte = new Date(endDate);
    }

    const [totalCount, baseRows] = await Promise.all([
      ShopifyFinanceOrder.countDocuments(findQuery),
      ShopifyFinanceOrder.find(findQuery)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    if (baseRows.length === 0) {
      return res.status(200).json({ orders: [], totalCount });
    }

    const orderNames = baseRows.map((r) => r.orderName).filter(Boolean);
    const { raw: rawKeys, clean: cleanKeys, numeric: numericKeys } = buildMatchSets(orderNames);

    // --- Fetch related data in bulk ---

    // 1) Order (tracking + courier + deliveredDate) by clean order_id (string)
    const ordersDocs = await Order.find({ order_id: { $in: cleanKeys } })
      .select("order_id tracking_number carrier_title last_updated_at")
      .lean();

    // 2) MyOrder (partialPayment) by raw/clean strings and (if any) numeric
    const myOrdersStrDocs = await MyOrder.find({ orderId: { $in: [...rawKeys, ...cleanKeys] } })
      .select("orderId partialPayment")
      .lean();

    let myOrdersNumDocs = [];
    if (numericKeys.length) {
      myOrdersNumDocs = await MyOrder.find({ orderId: { $in: numericKeys } })
        .select("orderId partialPayment")
        .lean();
    }

    // 3) Settlement UTRs + Amounts

    // Easebuzz: merchantOrderId can be "#1234", "1234", or 1234
    const easebuzzStrDocs = await EasebuzzTransaction.find({
      merchantOrderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("merchantOrderId settlementUTR amount")
      .lean();

    let easebuzzNumDocs = [];
    if (numericKeys.length) {
      easebuzzNumDocs = await EasebuzzTransaction.find({
        merchantOrderId: { $in: numericKeys },
      })
        .select("merchantOrderId settlementUTR amount")
        .lean();
    }

    // DTDC: customerReferenceNumber
    const dtdcStrDocs = await DtdcSettlement.find({
      customerReferenceNumber: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("customerReferenceNumber utrNumber codAmount")
      .lean();

    let dtdcNumDocs = [];
    if (numericKeys.length) {
      dtdcNumDocs = await DtdcSettlement.find({
        customerReferenceNumber: { $in: numericKeys },
      })
        .select("customerReferenceNumber utrNumber codAmount")
        .lean();
    }

    // Delhivery: orderId
    const delhiveryStrDocs = await DelhiverySettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utrNo amount")
      .lean();

    let delhiveryNumDocs = [];
    if (numericKeys.length) {
      delhiveryNumDocs = await DelhiverySettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utrNo amount")
        .lean();
    }

    // Bluedart: orderId
    const bluedartStrDocs = await BluedartSettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utr customerPayAmt")
      .lean();

    let bluedartNumDocs = [];
    if (numericKeys.length) {
      bluedartNumDocs = await BluedartSettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utr customerPayAmt")
        .lean();
    }

    // --- Build maps for quick lookups ---

    // Order map (by clean id)
    const mapOrderByCleanId = new Map();
    for (const od of ordersDocs) {
      mapOrderByCleanId.set((od.order_id || "").toString(), od);
    }

    // MyOrder map (index raw/clean/numeric)
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

    // Settlement UTR (priority) and Amount accumulation
    const mapUtrByKey = new Map();
    const mapAmountByKey = new Map();

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

    // Easebuzz (highest priority) — UTR + amount
    for (const ez of [...easebuzzStrDocs, ...easebuzzNumDocs]) {
      const kRaw = ez.merchantOrderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, ez.settlementUTR);
      setUtrPriority(sClean, ez.settlementUTR);
      if (sNum !== null) setUtrPriority(sNum, ez.settlementUTR);

      addAmount(sRaw, ez.amount);
      addAmount(sClean, ez.amount);
      if (sNum !== null) addAmount(sNum, ez.amount);
    }

    // DTDC — UTR + codAmount
    for (const d of [...dtdcStrDocs, ...dtdcNumDocs]) {
      const kRaw = d.customerReferenceNumber;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, d.utrNumber);
      setUtrPriority(sClean, d.utrNumber);
      if (sNum !== null) setUtrPriority(sNum, d.utrNumber);

      addAmount(sRaw, d.codAmount);
      addAmount(sClean, d.codAmount);
      if (sNum !== null) addAmount(sNum, d.codAmount);
    }

    // Delhivery — UTR + amount
    for (const dl of [...delhiveryStrDocs, ...delhiveryNumDocs]) {
      const kRaw = dl.orderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, dl.utrNo);
      setUtrPriority(sClean, dl.utrNo);
      if (sNum !== null) setUtrPriority(sNum, dl.utrNo);

      addAmount(sRaw, dl.amount);
      addAmount(sClean, dl.amount);
      if (sNum !== null) addAmount(sNum, dl.amount);
    }

    // Bluedart — UTR + customerPayAmt
    for (const bd of [...bluedartStrDocs, ...bluedartNumDocs]) {
      const kRaw = bd.orderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, bd.utr);
      setUtrPriority(sClean, bd.utr);
      if (sNum !== null) setUtrPriority(sNum, bd.utr);

      addAmount(sRaw, bd.customerPayAmt);
      addAmount(sClean, bd.customerPayAmt);
      if (sNum !== null) addAmount(sNum, bd.customerPayAmt);
    }

    // --- Compose final rows ---

    const rows = baseRows.map((r) => {
      const cleanId = normalizeOrderNameToId(r.orderName);
      const numericId = Number.isFinite(Number(cleanId)) ? Number(cleanId) : null;

      const od = mapOrderByCleanId.get(cleanId);
      const mo =
        mapMyOrderByAnyId.get(r.orderName) ||
        mapMyOrderByAnyId.get(cleanId) ||
        (numericId !== null ? mapMyOrderByAnyId.get(numericId) : undefined);

      const trackingId = od?.tracking_number || "--";
      const courierPartner = od?.carrier_title || "--";

      // Delivered Date from Order.last_updated_at
      const deliveredDate = od?.last_updated_at || null;

      const partialPayment = typeof mo?.partialPayment === "number" ? mo.partialPayment : 0;

      // Settlement UTR (check raw, clean, numeric)
      const utr =
        mapUtrByKey.get(r.orderName) ??
        mapUtrByKey.get(cleanId) ??
        (numericId !== null ? mapUtrByKey.get(numericId) : undefined) ??
        "";

      // Total Received = sum of Easebuzz.amount + DTDC.codAmount + Delhivery.amount + Bluedart.customerPayAmt
      const totalReceived =
        (mapAmountByKey.get(r.orderName) ?? 0) +
        (mapAmountByKey.get(cleanId) ?? 0) +
        (numericId !== null ? (mapAmountByKey.get(numericId) ?? 0) : 0);

      // Remaining = Total Received - Partial Payment (per your instruction)
      const remainingAmount = totalReceived - (partialPayment || 0);

      return {
        createdAt: r.createdAt,
        orderName: r.orderName,
        billingName: r.billingName,
        phone: r.phone,
        financialStatus: r.financialStatus,
        paymentMethod: r.paymentMethod,
        totalPrice: r.totalPrice,
        lmsNote: r.lmsNote,

        // enriched
        trackingId,
        courierPartner,
        customOrderStatus: "open",
        partialPayment,

        // computed
        deliveredDate,
        totalReceived,
        remainingAmount,

        // settlement & misc
        refund: "",
        settlementDate: "",
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
