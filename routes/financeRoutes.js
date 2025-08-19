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
    // we do not persist archived/cancelled; we filter those at refresh stage
  };
}

function normalizeOrderNameToId(orderName) {
  // "#12345" -> "12345"; also trim spaces
  return (orderName || "").toString().replace(/^#/, "").trim();
}

// for robust matching against settlements where IDs may be saved as strings or numbers
function buildMatchSets(orderNames) {
  const raw = new Set();       // e.g. "#1234"
  const clean = new Set();     // e.g. "1234"
  const numeric = new Set();   // e.g. 1234 (Number)

  for (const on of orderNames) {
    const rawKey = (on || "").toString().trim();
    const cleanKey = normalizeOrderNameToId(rawKey);

    if (rawKey) raw.add(rawKey);
    if (cleanKey) clean.add(cleanKey);

    // if clean is an integer, add numeric form too
    const n = Number(cleanKey);
    if (!Number.isNaN(n) && Number.isFinite(n) && String(n) === cleanKey) {
      numeric.add(n); // add number type to handle numeric-stored fields
    }
  }

  return { raw: [...raw], clean: [...clean], numeric: [...numeric] };
}

function nonEmpty(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === "string") return val.trim().length > 0;
  return true;
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
      const isArchived = !!o?.archived;            // boolean
      const isCancelled = !!o?.cancelled_at;       // date string if cancelled
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
 * - Courier Partner, Order Tracking ID from Order (by normalized order_id)
 * - Partial Payment from MyOrder (by both with-# and without-# and numeric)
 * - Settlement UTR from Easebuzz/Dtdc/Delhivery/Bluedart (robust match)
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
      // extra guard to exclude any old voided rows (if they exist)
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

    // 1) Order (tracking + courier) by clean order_id (string only; model stores string per your schema)
    const ordersDocs = await Order.find({ order_id: { $in: cleanKeys } })
      .select("order_id tracking_number carrier_title")
      .lean();

    // 2) MyOrder (partialPayment) by both with-# and without-# (strings).
    //    If some MyOrder.orderId are numbers, we still cover via a second query with numericKeys.
    const myOrdersStrDocs = await MyOrder.find({ orderId: { $in: [...rawKeys, ...cleanKeys] } })
      .select("orderId partialPayment")
      .lean();

    let myOrdersNumDocs = [];
    if (numericKeys.length) {
      // try to match numeric-stored orderId too
      myOrdersNumDocs = await MyOrder.find({ orderId: { $in: numericKeys } })
        .select("orderId partialPayment")
        .lean();
    }

    // 3) Settlement UTRs (query with strings and numbers where applicable)

    // Easebuzz: merchantOrderId may be "#1234", "1234" or numeric 1234
    const easebuzzStrDocs = await EasebuzzTransaction.find({
      merchantOrderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("merchantOrderId settlementUTR")
      .lean();

    let easebuzzNumDocs = [];
    if (numericKeys.length) {
      easebuzzNumDocs = await EasebuzzTransaction.find({
        merchantOrderId: { $in: numericKeys },
      })
        .select("merchantOrderId settlementUTR")
        .lean();
    }

    // DTDC: customerReferenceNumber === orderName
    const dtdcStrDocs = await DtdcSettlement.find({
      customerReferenceNumber: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("customerReferenceNumber utrNumber")
      .lean();

    let dtdcNumDocs = [];
    if (numericKeys.length) {
      dtdcNumDocs = await DtdcSettlement.find({
        customerReferenceNumber: { $in: numericKeys },
      })
        .select("customerReferenceNumber utrNumber")
        .lean();
    }

    // Delhivery: orderId === orderName
    const delhiveryStrDocs = await DelhiverySettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utrNo")
      .lean();

    let delhiveryNumDocs = [];
    if (numericKeys.length) {
      delhiveryNumDocs = await DelhiverySettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utrNo")
        .lean();
    }

    // Bluedart: orderId === orderName
    const bluedartStrDocs = await BluedartSettlement.find({
      orderId: { $in: [...rawKeys, ...cleanKeys] },
    })
      .select("orderId utr")
      .lean();

    let bluedartNumDocs = [];
    if (numericKeys.length) {
      bluedartNumDocs = await BluedartSettlement.find({
        orderId: { $in: numericKeys },
      })
        .select("orderId utr")
        .lean();
    }

    // --- Build maps for quick lookups ---

    // Order map (by clean id, string)
    const mapOrderByCleanId = new Map();
    for (const od of ordersDocs) {
      mapOrderByCleanId.set((od.order_id || "").toString(), od);
    }

    // MyOrder map (index both with and without # to the same doc).
    const mapMyOrderByAnyId = new Map();
    const indexMyOrder = (mo) => {
      const raw = (mo.orderId ?? "").toString().trim();
      const clean = normalizeOrderNameToId(raw);
      const numeric = Number.isFinite(Number(raw)) ? Number(raw) : null;

      if (raw) mapMyOrderByAnyId.set(raw, mo);
      if (clean) mapMyOrderByAnyId.set(clean, mo);
      if (numeric !== null) mapMyOrderByAnyId.set(numeric, mo);
    };
    [...myOrdersStrDocs, ...myOrdersNumDocs].forEach(indexMyOrder);

    // Settlement UTR map (store by all variants; priority Easebuzz > DTDC > Delhivery > Bluedart)
    const mapUtrByKey = new Map();

    const setUtrPriority = (key, utr) => {
      const u = (utr || "").toString().trim();
      if (!key || !u) return; // only set if non-empty
      if (!mapUtrByKey.has(key)) mapUtrByKey.set(key, u);
    };

    // Easebuzz (highest priority)
    for (const ez of [...easebuzzStrDocs, ...easebuzzNumDocs]) {
      const kRaw = ez.merchantOrderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, ez.settlementUTR);
      setUtrPriority(sClean, ez.settlementUTR);
      if (sNum !== null) setUtrPriority(sNum, ez.settlementUTR);
    }

    // DTDC
    for (const d of [...dtdcStrDocs, ...dtdcNumDocs]) {
      const kRaw = d.customerReferenceNumber;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, d.utrNumber);
      setUtrPriority(sClean, d.utrNumber);
      if (sNum !== null) setUtrPriority(sNum, d.utrNumber);
    }

    // Delhivery
    for (const dl of [...delhiveryStrDocs, ...delhiveryNumDocs]) {
      const kRaw = dl.orderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, dl.utrNo);
      setUtrPriority(sClean, dl.utrNo);
      if (sNum !== null) setUtrPriority(sNum, dl.utrNo);
    }

    // Bluedart
    for (const bd of [...bluedartStrDocs, ...bluedartNumDocs]) {
      const kRaw = bd.orderId;
      const sRaw = (kRaw ?? "").toString().trim();
      const sClean = normalizeOrderNameToId(sRaw);
      const sNum = Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;

      setUtrPriority(sRaw, bd.utr);
      setUtrPriority(sClean, bd.utr);
      if (sNum !== null) setUtrPriority(sNum, bd.utr);
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
      const partialPayment = typeof mo?.partialPayment === "number" ? mo.partialPayment : 0;

      // Settlement UTR (check raw, clean, numeric)
      const utr =
        mapUtrByKey.get(r.orderName) ??
        mapUtrByKey.get(cleanId) ??
        (numericId !== null ? mapUtrByKey.get(numericId) : undefined) ??
        "";

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
        deliveredDate: null, // (wire later)
        totalReceived: 0,
        remainingAmount: r.totalPrice - (partialPayment || 0),
 
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
