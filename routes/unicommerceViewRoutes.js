const express = require("express");
const axios = require("axios");

const router = express.Router();

const Order = require("../models/Order");
const ShopifyOrder = require("../models/ShopifyOrder");

const UNI_BASE = `https://${process.env.UNICOMMERCE_TENANT}.unicommerce.com`;
const UNI_USERNAME = process.env.UNICOMMERCE_USERNAME;
const UNI_PASSWORD = process.env.UNICOMMERCE_PASSWORD;
const UNI_FACILITY = process.env.UNICOMMERCE_FACILITY_CODE || "";

const RAW_PAGE_SIZE = 100;
const MAX_INTERNAL_PAGES = 200;
const ENRICH_CONCURRENCY = 5;

let uniTokenCache = {
  accessToken: null,
  expiresAt: 0,
};

const RTO_KEYWORDS = [
  "returned to origin",
  "return to origin",
  "rto",
  "return to sender",
  "shipper's request",
  "returned back",
];

const DELIVERED_KEYWORDS = [
  "shipment delivered",
  "delivered",
];

const TRANSIT_KEYWORDS = [
  "in transit",
  "transit",
  "dispatch",
  "dispatched",
  "shipped",
];

const HOLD_KEYWORDS = ["hold"];
const CANCELED_KEYWORDS = ["cancelled", "canceled", "cancel"];

async function getUniwareToken() {
  const now = Date.now();

  if (uniTokenCache.accessToken && uniTokenCache.expiresAt > now + 60 * 1000) {
    return uniTokenCache.accessToken;
  }

  const url = `${UNI_BASE}/oauth/token`;

  const { data } = await axios.get(url, {
    params: {
      grant_type: "password",
      client_id: "my-trusted-client",
      username: UNI_USERNAME,
      password: UNI_PASSWORD,
    },
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  uniTokenCache.accessToken = data.access_token;
  uniTokenCache.expiresAt = now + ((data.expires_in || 3600) * 1000);

  return uniTokenCache.accessToken;
}

function tenantHeaders(accessToken) {
  return {
    Authorization: `bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

function facilityHeaders(accessToken) {
  return {
    Authorization: `bearer ${accessToken}`,
    Facility: UNI_FACILITY,
    "Content-Type": "application/json",
  };
}

function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function joinText(values = []) {
  return values
    .filter(Boolean)
    .map((v) => String(v).trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasAny(text, keywords = []) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return keywords.some((keyword) => normalized.includes(keyword));
}

function isRtoText(text) {
  return hasAny(text, RTO_KEYWORDS);
}

function isDeliveredText(text) {
  return hasAny(text, DELIVERED_KEYWORDS);
}

function isTransitText(text) {
  return hasAny(text, TRANSIT_KEYWORDS);
}

function isHoldText(text) {
  return hasAny(text, HOLD_KEYWORDS);
}

function isCanceledText(text) {
  return hasAny(text, CANCELED_KEYWORDS);
}

function getChannelText(saleOrder = {}) {
  return [
    saleOrder?.channel,
    saleOrder?.channelName,
    saleOrder?.marketplace,
    saleOrder?.marketplaceName,
    saleOrder?.saleChannel,
    saleOrder?.displayChannelName,
  ]
    .filter(Boolean)
    .map((v) => String(v).trim())
    .join(" | ");
}

function isShopifyChannel(saleOrder = {}) {
  return getChannelText(saleOrder).toLowerCase().includes("shopify");
}

/**
 * Allowed input:
 * MA123456
 * #MA123456
 * 123456
 *
 * Always saved as:
 * MA123456
 */
function canonicalOrderId(value = "") {
  const raw = String(value || "").trim().toUpperCase().replace(/^#/, "");

  if (!raw) return "";

  if (/^MA\d{6}$/.test(raw)) {
    return raw;
  }

  if (/^\d{6}$/.test(raw)) {
    return `MA${raw}`;
  }

  return "";
}

function buildOrderIdVariants(orderId = "") {
  const canonical = canonicalOrderId(orderId);
  if (!canonical) return [];

  const digits = canonical.replace(/^MA/, "");

  return [
    canonical,
    `#${canonical}`,
    digits,
  ];
}

function getOrderDate(saleOrder = {}, saleOrderDetails = null) {
  return (
    safeDate(saleOrder?.displayOrderDateTime) ||
    safeDate(saleOrder?.created) ||
    safeDate(saleOrderDetails?.created) ||
    null
  );
}

function chooseLatestPackage(packages = []) {
  if (!Array.isArray(packages) || packages.length === 0) return null;

  return [...packages].sort((a, b) => {
    const ad =
      safeDate(a.updated) ||
      safeDate(a.delivered) ||
      safeDate(a.dispatched) ||
      safeDate(a.created) ||
      new Date(0);

    const bd =
      safeDate(b.updated) ||
      safeDate(b.delivered) ||
      safeDate(b.dispatched) ||
      safeDate(b.created) ||
      new Date(0);

    return bd - ad;
  })[0];
}

function getPackageStatusText(pkg = {}) {
  return joinText([
    pkg?.status,
    pkg?.trackingStatus,
    pkg?.courierStatus,
    pkg?.statusDescription,
    pkg?.remarks,
    pkg?.currentStatus,
    pkg?.shippingStatus,
    pkg?.latestTrackingEvent,
    pkg?.eventName,
    pkg?.eventDescription,
  ]);
}

function getOrderLevelStatusText(saleOrder = {}, saleOrderDetails = null) {
  return joinText([
    saleOrder?.status,
    saleOrder?.orderStatus,
    saleOrder?.displayStatus,
    saleOrder?.statusCode,
    saleOrder?.state,
    saleOrder?.shippingStatus,
    saleOrder?.fulfillmentStatus,
    saleOrder?.currentStatus,
    saleOrderDetails?.status,
    saleOrderDetails?.orderStatus,
    saleOrderDetails?.displayStatus,
    saleOrderDetails?.statusCode,
    saleOrderDetails?.state,
    saleOrderDetails?.shippingStatus,
    saleOrderDetails?.fulfillmentStatus,
    saleOrderDetails?.currentStatus,
  ]);
}

function mapSinglePackageStatus(pkg = {}) {
  const txt = getPackageStatusText(pkg);

  const hasRto = isRtoText(txt);
  const hasDelivered = Boolean(pkg?.delivered) || isDeliveredText(txt);
  const hasTransit = Boolean(pkg?.dispatched) || isTransitText(txt);
  const hasHold = isHoldText(txt);
  const hasCanceled = isCanceledText(txt);

  if (hasRto && hasDelivered) return "RTO Delivered";
  if (hasRto) return "RTO";
  if (hasDelivered) return "Delivered";
  if (hasTransit) return "In Transit";
  if (hasHold) return "On Hold";
  if (hasCanceled) return "Canceled";

  return pkg?.status || pkg?.trackingStatus || pkg?.courierStatus || "";
}

/**
 * Main business rule:
 * - if order is in RTO flow, and latest phase is delivered -> RTO Delivered
 * - if order is in RTO flow, and latest phase is not delivered -> RTO
 * - only use Delivered when there is no RTO flow
 */
function deriveShipmentStatus({
  saleOrder = {},
  saleOrderDetails = null,
  packages = [],
}) {
  const orderText = getOrderLevelStatusText(saleOrder, saleOrderDetails);
  const latestPkg = chooseLatestPackage(packages);
  const latestPkgStatus = latestPkg ? mapSinglePackageStatus(latestPkg) : "";

  const packageStatuses = Array.isArray(packages)
    ? packages.map((pkg) => mapSinglePackageStatus(pkg)).filter(Boolean)
    : [];

  const hasRtoFlow =
    isRtoText(orderText) ||
    packageStatuses.includes("RTO") ||
    packageStatuses.includes("RTO Delivered");

  if (hasRtoFlow) {
    if (
      latestPkgStatus === "Delivered" ||
      latestPkgStatus === "RTO Delivered" ||
      packageStatuses.includes("RTO Delivered")
    ) {
      return "RTO Delivered";
    }

    return "RTO";
  }

  if (latestPkgStatus === "Delivered") return "Delivered";
  if (latestPkgStatus === "In Transit") return "In Transit";
  if (latestPkgStatus === "On Hold") return "On Hold";
  if (latestPkgStatus === "Canceled") return "Canceled";

  if (packageStatuses.includes("Delivered")) return "Delivered";
  if (packageStatuses.includes("In Transit")) return "In Transit";
  if (packageStatuses.includes("On Hold")) return "On Hold";
  if (packageStatuses.includes("Canceled")) return "Canceled";

  if (isDeliveredText(orderText)) return "Delivered";
  if (isTransitText(orderText)) return "In Transit";
  if (isHoldText(orderText)) return "On Hold";
  if (isCanceledText(orderText)) return "Canceled";

  return saleOrderDetails?.status || saleOrder?.status || "";
}

async function searchSaleOrders({
  accessToken,
  page,
  limit,
  startDate,
  endDate,
  search,
}) {
  const url = `${UNI_BASE}/services/rest/v1/oms/saleOrder/search`;

  const payload = {
    searchOptions: {
      displayLength: limit,
      displayStart: (page - 1) * limit,
      getCount: true,
    },
  };

  if (startDate) {
    payload.fromDate = new Date(`${startDate}T00:00:00.000Z`).toISOString();
    payload.dateType = "CREATED";
  }

  if (endDate) {
    payload.toDate = new Date(`${endDate}T23:59:59.999Z`).toISOString();
    payload.dateType = "CREATED";
  }

  if (search && String(search).trim()) {
    payload.searchOptions.searchKey = String(search).trim();
  }

  const { data } = await axios.post(url, payload, {
    headers: tenantHeaders(accessToken),
    timeout: 30000,
  });

  return Array.isArray(data?.elements) ? data.elements : [];
}

async function getSaleOrder(accessToken, code) {
  const url = `${UNI_BASE}/services/rest/v1/oms/saleorder/get`;

  const payload = {
    code,
    paymentDetailRequired: false,
  };

  const { data } = await axios.post(url, payload, {
    headers: tenantHeaders(accessToken),
    timeout: 30000,
  });

  return data?.saleOrderDTO || data?.saleOrder || data || null;
}

async function searchShippingPackages(accessToken, saleOrderCode) {
  const url = `${UNI_BASE}/services/rest/v1/oms/shippingPackage/search`;

  const payload = {
    saleOrderCode,
    searchOptions: {
      displayLength: 20,
      displayStart: 0,
      getCount: true,
    },
  };

  const { data } = await axios.post(url, payload, {
    headers: facilityHeaders(accessToken),
    timeout: 30000,
  });

  return Array.isArray(data?.elements) ? data.elements : [];
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      () => runner()
    )
  );

  return results;
}

function getUnicommerceOrderId(saleOrder = {}, saleOrderDetails = null) {
  const candidates = [
    saleOrder?.displayOrderCode,
    saleOrderDetails?.displayOrderCode,
    saleOrder?.channelOrderReference,
    saleOrderDetails?.channelOrderReference,
    saleOrder?.referenceCode,
    saleOrderDetails?.referenceCode,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = canonicalOrderId(candidate);
    if (normalized) return normalized;
  }

  return "";
}

async function findMatchingShopifyOrderByOrderId(orderId) {
  const variants = buildOrderIdVariants(orderId);
  if (!variants.length) return null;

  const numericIds = variants
    .map((v) => v.replace(/^#/, "").replace(/^MA/, ""))
    .filter((v) => /^\d{6}$/.test(v))
    .map((v) => Number(v));

  const orConditions = [{ orderName: { $in: variants } }];

  if (numericIds.length) {
    orConditions.push({ orderId: { $in: [...new Set(numericIds)] } });
  }

  return ShopifyOrder.findOne({ $or: orConditions })
    .sort({ shopifyCreatedAt: -1, createdAt: -1 })
    .lean();
}

async function collectShopifyChannelOrders({
  accessToken,
  startDate,
  endDate,
  search,
}) {
  let internalPage = 1;
  let rawOrdersSeen = 0;
  const shopifyChannelOrders = [];

  while (internalPage <= MAX_INTERNAL_PAGES) {
    const rawOrders = await searchSaleOrders({
      accessToken,
      page: internalPage,
      limit: RAW_PAGE_SIZE,
      startDate,
      endDate,
      search,
    });

    if (!rawOrders.length) break;

    rawOrdersSeen += rawOrders.length;

    for (const order of rawOrders) {
      if (isShopifyChannel(order)) {
        shopifyChannelOrders.push(order);
      }
    }

    if (rawOrders.length < RAW_PAGE_SIZE) break;
    internalPage += 1;
  }

  return { rawOrdersSeen, shopifyChannelOrders };
}

/**
 * GET /api/shopify-orders-live
 */
router.get("/shopify-orders-live", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      100
    );
    const { startDate, endDate, search } = req.query;

    const accessToken = await getUniwareToken();

    const { rawOrdersSeen, shopifyChannelOrders } =
      await collectShopifyChannelOrders({
        accessToken,
        startDate,
        endDate,
        search,
      });

    const start = (page - 1) * limit;
    const end = start + limit;
    const pagedOrders = shopifyChannelOrders.slice(start, end);

    const rows = await mapWithConcurrency(
      pagedOrders,
      ENRICH_CONCURRENCY,
      async (saleOrder) => {
        let saleOrderDetails = null;
        let packages = [];
        let latestPkg = null;

        try {
          saleOrderDetails = await getSaleOrder(accessToken, saleOrder.code);
        } catch (_) {
          saleOrderDetails = null;
        }

        try {
          packages = await searchShippingPackages(accessToken, saleOrder.code);
          latestPkg = chooseLatestPackage(packages);
        } catch (_) {
          packages = [];
          latestPkg = null;
        }

        const orderId = getUnicommerceOrderId(saleOrder, saleOrderDetails);

        return {
          order_id: orderId || "-",
          shipment_status: deriveShipmentStatus({
            saleOrder,
            saleOrderDetails,
            packages,
          }),
          order_date: getOrderDate(saleOrder, saleOrderDetails),
          tracking_number: latestPkg?.trackingNumber || "",
          carrier_title: latestPkg?.shippingProvider || "",
          channel_text: getChannelText(saleOrder),
        };
      }
    );

    return res.status(200).json({
      success: true,
      rawOrdersSeen,
      totalOrders: shopifyChannelOrders.length,
      page,
      limit,
      orders: rows,
    });
  } catch (error) {
    console.error(
      "shopify-orders-live error:",
      error?.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.response?.data || error.message,
    });
  }
});

/**
 * POST /api/orders/backfill-shopify-to-order
 */
router.post("/orders/backfill-shopify-to-order", async (req, res) => {
  try {
    const startDate = req.body?.startDate || "2026-03-06";
    const endDate = req.body?.endDate || "";
    const search = req.body?.search || "";

    const accessToken = await getUniwareToken();

    const { rawOrdersSeen, shopifyChannelOrders } =
      await collectShopifyChannelOrders({
        accessToken,
        startDate,
        endDate,
        search,
      });

    const enrichedRows = await mapWithConcurrency(
      shopifyChannelOrders,
      ENRICH_CONCURRENCY,
      async (saleOrder) => {
        let saleOrderDetails = null;
        let packages = [];
        let latestPkg = null;

        try {
          saleOrderDetails = await getSaleOrder(accessToken, saleOrder.code);
        } catch (_) {
          saleOrderDetails = null;
        }

        try {
          packages = await searchShippingPackages(accessToken, saleOrder.code);
          latestPkg = chooseLatestPackage(packages);
        } catch (_) {
          packages = [];
          latestPkg = null;
        }

        const orderId = getUnicommerceOrderId(saleOrder, saleOrderDetails);
        if (!orderId) return null;

        let shopifyOrder = null;
        try {
          shopifyOrder = await findMatchingShopifyOrderByOrderId(orderId);
        } catch (_) {
          shopifyOrder = null;
        }

        return {
          order_id: orderId,
          shipment_status: deriveShipmentStatus({
            saleOrder,
            saleOrderDetails,
            packages,
          }),
          order_date: getOrderDate(saleOrder, saleOrderDetails),
          tracking_number: latestPkg?.trackingNumber || "",
          carrier_title: latestPkg?.shippingProvider || "",
          contact_number:
            shopifyOrder?.contactNumber ||
            shopifyOrder?.normalizedPhone ||
            shopifyOrder?.customerAddress?.phone ||
            "",
          full_name:
            shopifyOrder?.customerName ||
            shopifyOrder?.customerAddress?.name ||
            "",
          has_shopify_match: Boolean(shopifyOrder),
        };
      }
    );

    const validRows = enrichedRows.filter((row) => row && row.order_id);
    const matchedShopifyCount = validRows.filter(
      (row) => row.has_shopify_match
    ).length;

    if (!validRows.length) {
      return res.status(200).json({
        success: true,
        message: "No valid order ids found in Shopify-channel Unicommerce orders",
        startDate,
        endDate: endDate || null,
        rawOrdersSeen,
        totalFetchedShopifyChannelOrders: shopifyChannelOrders.length,
        totalProcessed: 0,
        matchedShopifyOrderCount: 0,
        inserted: 0,
        updated: 0,
        sample: [],
      });
    }

    const existing = await Order.find({
      order_id: { $in: validRows.map((x) => x.order_id) },
    })
      .select("order_id")
      .lean();

    const existingSet = new Set(existing.map((x) => x.order_id));

    await Order.bulkWrite(
      validRows.map((row) => ({
        updateOne: {
          filter: { order_id: row.order_id },
          update: {
            $set: {
              order_id: row.order_id,
              shipment_status: row.shipment_status || "",
              order_date: row.order_date || null,
              tracking_number: row.tracking_number || "",
              carrier_title: row.carrier_title || "",
              contact_number: row.contact_number || "",
              full_name: row.full_name || "",
              last_updated_at: new Date(),
            },
            $setOnInsert: {
              selfUpdated: false,
              email_count: 0,
              threadId: "",
              issue: "",
              opsRemark: "",
              assignedAgentId: null,
              notificationFlags: { rtoNotified: false },
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    const inserted = validRows.filter(
      (row) => !existingSet.has(row.order_id)
    ).length;
    const updated = validRows.filter((row) =>
      existingSet.has(row.order_id)
    ).length;

    return res.status(200).json({
      success: true,
      message: "Shopify-channel Unicommerce orders were backfilled successfully",
      startDate,
      endDate: endDate || null,
      rawOrdersSeen,
      totalFetchedShopifyChannelOrders: shopifyChannelOrders.length,
      totalProcessed: validRows.length,
      matchedShopifyOrderCount: matchedShopifyCount,
      inserted,
      updated,
      sample: validRows.slice(0, 10),
    });
  } catch (error) {
    console.error("Backfill error:", error?.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to backfill Order collection",
      error: error.response?.data || error.message,
    });
  }
});

/**
 * POST /api/orders/fix-order-id-format
 * Converts old saved numeric ids like 111147 -> MA111147
 */
router.post("/orders/fix-order-id-format", async (req, res) => {
  try {
    const startDate = req.body?.startDate || "2026-03-06";
    const start = new Date(`${startDate}T00:00:00.000Z`);

    const rows = await Order.find({
      order_date: { $gte: start },
      order_id: /^\d{6}$/,
    })
      .select("_id order_id")
      .lean();

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        message: "No plain numeric order ids found to fix",
        updatedCount: 0,
        sample: [],
      });
    }

    await Order.bulkWrite(
      rows.map((row) => ({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              order_id: `MA${row.order_id}`,
            },
          },
        },
      })),
      { ordered: false }
    );

    return res.status(200).json({
      success: true,
      message: "Saved order ids updated to MA format successfully",
      updatedCount: rows.length,
      sample: rows.slice(0, 10).map((r) => ({
        old_order_id: r.order_id,
        new_order_id: `MA${r.order_id}`,
      })),
    });
  } catch (error) {
    console.error("fix-order-id-format error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fix saved order ids",
      error: error.message,
    });
  }
});

/**
 * DELETE /api/orders/delete-after-date
 */
router.delete("/orders/delete-after-date", async (req, res) => {
  try {
    const startDate = req.body?.startDate || "2026-03-06";
    const start = new Date(`${startDate}T00:00:00.000Z`);

    const result = await Order.deleteMany({
      order_date: { $gte: start },
    });

    return res.status(200).json({
      success: true,
      message: `Orders on or after ${startDate} deleted successfully`,
      startDate,
      deletedCount: result.deletedCount || 0,
    });
  } catch (error) {
    console.error("Delete after date error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to delete orders",
      error: error.message,
    });
  }
});

module.exports = router;