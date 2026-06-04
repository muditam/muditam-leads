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
const AMBIGUOUS_COMPLETE_STATUSES = new Set(["complete", "completed"]);
const STATUS_PENDING = "Status Pending";
const STATUS_PROCESSING = "Processing";
const STATUS_IN_TRANSIT = "In Transit";
const STATUS_DELIVERED = "Delivered";
const STATUS_RTO = "RTO";
const STATUS_RTO_DELIVERED = "RTO Delivered";
const STATUS_UNDELIVERED = "Undelivered";
const STATUS_CANCELED = "Canceled";
const STATUS_UNKNOWN = "UNKNOWN";
const ALLOWED_FINAL_STATUSES = new Set([
  STATUS_DELIVERED,
  STATUS_RTO,
  STATUS_IN_TRANSIT,
  STATUS_PROCESSING,
  STATUS_RTO_DELIVERED,
  STATUS_UNDELIVERED,
]);

const EXACT_DELIVERED_CODES = new Set([
  "DELIVERED",
  "DELIVERED_TO_CUSTOMER",
  "DELIVERED_SHIPMENT_DELIVERED",
]);

const EXACT_RTO_DELIVERED_CODES = new Set([
  "RTO_DELIVERED_TO_SELLER",
]);

const EXACT_RTO_CODES = new Set([
  "RTO_INITIATED",
  "RTO_IN_TRANSIT",
  "RTO_DELAYED",
  "RTO_REACHED_AT_DESTINATION",
  "RTO_OUT_FOR_DELIVERY",
  "RTO_UNDELIVERED",
  "RTO_LOST",
  "RETURN_PENDING",
  "RETURNED_TO_ORIGIN",
  "RETURNED_CONSIGNEE_ADDRESS_INCOMPLETE",
  "RETURNED_CONSIGNEE_ADDRESS_INCORRECT",
  "RETURNED_CONSIGNEE_NOT_AVAILABLE",
  "RETURNED_CONSIGNEE_REFUSED_TO_ACCEPT",
  "RETURNED_CONSIGNEE_REFUSED_TO_PAY",
  "RETURNED_OUT_OF_DELIVERY_AREA",
]);

const EXACT_UNDELIVERED_CODES = new Set([
  "UNDELIVERED",
  "NOT_SERVICEABLE",
  "INCORRECT_WAYBILL_NUMBER",
  "PENDING_CONSIGNEE_ADDRESS_INCOMPLETE",
  "PENDING_CONSIGNEE_ADDRESS_INCORRECT",
  "PENDING_CONSIGNEE_NOT_AVAILABLE",
  "PENDING_CONSIGNEE_REFUSED_TO_ACCEPT",
  "PENDING_CONSIGNEE_REFUSED_TO_PAY",
  "PENDING_OUT_OF_DELIVERY_AREA",
  "PENDING_PROHIBITED_AREA",
  "PENDING_SCHEDULED_FOR_NEXT_DAY_DELIVERY",
  "DAMAGED",
  "DESTROYED",
  "LOST",
]);

const EXACT_IN_TRANSIT_CODES = new Set([
  "COMPLETE",
  "DISPATCHED",
  "PICKED_UP",
  "IN_TRANSIT",
  "DELAYED",
  "HELD",
  "REACHED_AT_DESTINATION",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "CUSTOM_CLEARED",
  "STATUS_NOT_DEFINED",
  "CONTACT_CUSTOMER_CARE",
  "NO_INFORMATION",
  "PENDING_AWAITING_DELIVERY_INFORMATION",
  "PENDING_DELAYED",
  "PENDING_IN_TRANSIT",
  "PENDING_MISROUTED",
  "PENDING_NO_INFORMATION",
  "PENDING_REDIRECTED_SHIPMENT",
  "PENDING_SHIPMENT_CONFISCATED",
  "PENDING_SHIPMENT_HELD_AT_DESTINATION",
  "PENDING_SHIPMENT_MANIFESTED_NOT_RECEIVED",
]);

const EXACT_PROCESSING_CODES = new Set([
  "CREATED",
  "PROCESSING",
  "PENDING_VERIFICATION",
  "PICKING",
  "PICKED",
  "PACKED",
  "READY_TO_SHIP",
  "COURIER_ASSIGNED",
  "PICKUP_PENDING",
  "PICKUP_RESCHEDULED",
  "OUT_FOR_PICKUP",
  "MANIFESTED",
]);

const EXACT_CANCELED_CODES = new Set([
  "CANCELLED",
  "CANCELED",
  "ORDER_CANCELLED",
]);

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

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
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
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\bdelivered\b/.test(normalized) && !/\bundelivered\b/.test(normalized);
}

function isUndeliveredText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\bundelivered\b/.test(normalized) || normalized.includes("not delivered");
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

function isAmbiguousCompleteStatus(value) {
  return AMBIGUOUS_COMPLETE_STATUSES.has(normalizeText(value));
}

function normalizeFallbackStatus(value) {
  if (!value) return STATUS_PENDING;
  if (isAmbiguousCompleteStatus(value)) return STATUS_IN_TRANSIT;
  return value;
}

function firstMatchingStatus(codes = []) {
  if (codes.some((code) => EXACT_RTO_DELIVERED_CODES.has(code))) return STATUS_RTO_DELIVERED;
  if (codes.some((code) => EXACT_DELIVERED_CODES.has(code))) return STATUS_DELIVERED;
  if (codes.some((code) => EXACT_RTO_CODES.has(code))) return STATUS_RTO;
  if (codes.some((code) => EXACT_UNDELIVERED_CODES.has(code))) return STATUS_UNDELIVERED;
  if (codes.some((code) => EXACT_IN_TRANSIT_CODES.has(code))) return STATUS_IN_TRANSIT;
  if (codes.some((code) => EXACT_PROCESSING_CODES.has(code))) return STATUS_PROCESSING;
  if (codes.some((code) => EXACT_CANCELED_CODES.has(code))) return STATUS_CANCELED;
  return "";
}

function getOrderItems(saleOrder = {}, saleOrderDetails = null) {
  const candidates = [
    saleOrderDetails?.orderItems,
    saleOrderDetails?.saleOrderItems,
    saleOrderDetails?.items,
    saleOrderDetails?.saleOrderItemDTOs,
    saleOrder?.orderItems,
    saleOrder?.saleOrderItems,
    saleOrder?.items,
    saleOrder?.saleOrderItemDTOs,
  ];

  return candidates.find((items) => Array.isArray(items)) || [];
}

function getItemStatusText(item = {}) {
  return joinText([
    item?.status,
    item?.itemStatus,
    item?.orderItemStatus,
    item?.statusCode,
    item?.shippingStatus,
    item?.fulfillmentStatus,
    item?.returnStatus,
    item?.reversePickupStatus,
    item?.rtoStatus,
  ]);
}

function getItemStatusCodes(item = {}) {
  return [
    item?.statusCode,
    item?.status,
    item?.itemStatus,
    item?.orderItemStatus,
    item?.shippingStatus,
    item?.fulfillmentStatus,
    item?.returnStatus,
    item?.reversePickupStatus,
    item?.rtoStatus,
  ]
    .filter(Boolean)
    .map(normalizeCode);
}

function mapSingleItemStatus(item = {}) {
  const exact = firstMatchingStatus(getItemStatusCodes(item));
  if (exact) return exact;

  const txt = getItemStatusText(item);

  if (!txt) return "";
  if (txt.includes("courier_return") || isRtoText(txt)) return STATUS_RTO;
  if (isUndeliveredText(txt)) return STATUS_UNDELIVERED;
  if (isDeliveredText(txt)) return STATUS_DELIVERED;
  if (isTransitText(txt)) return STATUS_IN_TRANSIT;
  if (isCanceledText(txt)) return STATUS_CANCELED;

  return "";
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
    safeDate(saleOrder?.createdOn) ||
    safeDate(saleOrderDetails?.created) ||
    safeDate(saleOrderDetails?.createdOn) ||
    null
  );
}

function chooseLatestPackage(packages = []) {
  if (!Array.isArray(packages) || packages.length === 0) return null;

  return [...packages].sort((a, b) => {
    const ad =
      safeDate(a.updated) ||
      safeDate(a.updatedOn) ||
      safeDate(a.delivered) ||
      safeDate(a.deliveredOn) ||
      safeDate(a.dispatched) ||
      safeDate(a.dispatchedOn) ||
      safeDate(a.created) ||
      safeDate(a.createdOn) ||
      new Date(0);

    const bd =
      safeDate(b.updated) ||
      safeDate(b.updatedOn) ||
      safeDate(b.delivered) ||
      safeDate(b.deliveredOn) ||
      safeDate(b.dispatched) ||
      safeDate(b.dispatchedOn) ||
      safeDate(b.created) ||
      safeDate(b.createdOn) ||
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

function getPackageStatusCodes(pkg = {}) {
  return [
    pkg?.statusCode,
    pkg?.trackingStatus,
    pkg?.courierStatus,
    pkg?.status,
    pkg?.currentStatus,
    pkg?.shippingStatus,
    pkg?.latestTrackingEvent,
    pkg?.eventName,
  ]
    .filter(Boolean)
    .map(normalizeCode);
}

function getOrderLevelStatusCodes(saleOrder = {}, saleOrderDetails = null) {
  return [
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
  ]
    .filter(Boolean)
    .map(normalizeCode);
}

function mapSinglePackageStatus(pkg = {}) {
  const exact = firstMatchingStatus(getPackageStatusCodes(pkg));
  if (exact) return exact;

  const txt = getPackageStatusText(pkg);

  const hasRto = isRtoText(txt);
  const hasDelivered = Boolean(pkg?.delivered) || isDeliveredText(txt);
  const hasTransit = Boolean(pkg?.dispatched) || isTransitText(txt);
  const hasHold = isHoldText(txt);
  const hasCanceled = isCanceledText(txt);
  const hasUndelivered = isUndeliveredText(txt);

  if (hasRto && hasDelivered) return STATUS_RTO_DELIVERED;
  if (hasRto) return STATUS_RTO;
  if (hasUndelivered) return STATUS_UNDELIVERED;
  if (hasDelivered) return STATUS_DELIVERED;
  if (hasTransit) return STATUS_IN_TRANSIT;
  if (hasHold) return STATUS_IN_TRANSIT;
  if (hasCanceled) return STATUS_CANCELED;

  return normalizeFallbackStatus(
    pkg?.statusCode || pkg?.trackingStatus || pkg?.courierStatus || pkg?.status || ""
  );
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
  const orderCodes = getOrderLevelStatusCodes(saleOrder, saleOrderDetails);
  const orderExactStatus = firstMatchingStatus(orderCodes);
  const latestPkg = chooseLatestPackage(packages);
  const latestPkgStatus = latestPkg ? mapSinglePackageStatus(latestPkg) : "";
  const orderItems = getOrderItems(saleOrder, saleOrderDetails);
  const itemStatuses = orderItems.map((item) => mapSingleItemStatus(item)).filter(Boolean);

  const packageStatuses = Array.isArray(packages)
    ? packages.map((pkg) => mapSinglePackageStatus(pkg)).filter(Boolean)
    : [];

  if (latestPkgStatus && latestPkgStatus !== STATUS_PENDING) return latestPkgStatus;

  if (packageStatuses.includes(STATUS_RTO_DELIVERED)) return STATUS_RTO_DELIVERED;
  if (packageStatuses.includes(STATUS_RTO)) return STATUS_RTO;
  if (packageStatuses.includes(STATUS_DELIVERED)) return STATUS_DELIVERED;
  if (packageStatuses.includes(STATUS_UNDELIVERED)) return STATUS_UNDELIVERED;
  if (packageStatuses.includes(STATUS_IN_TRANSIT)) return STATUS_IN_TRANSIT;
  if (packageStatuses.includes(STATUS_PROCESSING)) return STATUS_PROCESSING;
  if (packageStatuses.includes(STATUS_CANCELED)) return STATUS_CANCELED;

  if (itemStatuses.includes(STATUS_RTO_DELIVERED)) return STATUS_RTO_DELIVERED;
  if (itemStatuses.includes(STATUS_RTO)) return STATUS_RTO;
  if (itemStatuses.includes(STATUS_DELIVERED)) return STATUS_DELIVERED;
  if (itemStatuses.includes(STATUS_UNDELIVERED)) return STATUS_UNDELIVERED;
  if (itemStatuses.includes(STATUS_IN_TRANSIT)) return STATUS_IN_TRANSIT;
  if (itemStatuses.includes(STATUS_PROCESSING)) return STATUS_PROCESSING;
  if (itemStatuses.includes(STATUS_CANCELED)) return STATUS_CANCELED;

  if (orderExactStatus) return orderExactStatus;

  if (isRtoText(orderText) && isDeliveredText(orderText)) return STATUS_RTO_DELIVERED;
  if (isRtoText(orderText)) return STATUS_RTO;
  if (isUndeliveredText(orderText)) return STATUS_UNDELIVERED;
  if (isDeliveredText(orderText)) return STATUS_DELIVERED;
  if (isTransitText(orderText) || isAmbiguousCompleteStatus(orderText)) return STATUS_IN_TRANSIT;
  if (normalizeCode(orderText) === "PROCESSING") return STATUS_PROCESSING;
  if (isCanceledText(orderText)) return STATUS_CANCELED;

  return normalizeFallbackStatus(
    saleOrderDetails?.statusCode ||
      saleOrderDetails?.status ||
      saleOrder?.statusCode ||
      saleOrder?.status ||
      ""
  );
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
        let saleOrderFetchOk = true;
        let packageFetchOk = true;

        try {
          saleOrderDetails = await getSaleOrder(accessToken, saleOrder.code);
        } catch (_) {
          saleOrderDetails = null;
          saleOrderFetchOk = false;
        }

        try {
          packages = await searchShippingPackages(accessToken, saleOrder.code);
          latestPkg = chooseLatestPackage(packages);
        } catch (_) {
          packages = [];
          latestPkg = null;
          packageFetchOk = false;
        }

        const orderId = getUnicommerceOrderId(saleOrder, saleOrderDetails);
        const shipmentStatus = deriveShipmentStatus({
          saleOrder,
          saleOrderDetails,
          packages,
        });

        return {
          order_id: orderId || "-",
          shipment_status: shipmentStatus,
          order_date: getOrderDate(saleOrder, saleOrderDetails),
          tracking_number: latestPkg?.trackingNumber || "",
          carrier_title: latestPkg?.shippingProvider || "",
          channel_text: getChannelText(saleOrder),
          is_uncertain:
            !saleOrderFetchOk || !packageFetchOk,
          can_backfill:
            saleOrderFetchOk &&
            packageFetchOk &&
            Boolean(orderId) &&
            ALLOWED_FINAL_STATUSES.has(shipmentStatus),
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
        let saleOrderFetchOk = true;
        let packageFetchOk = true;

        try {
          saleOrderDetails = await getSaleOrder(accessToken, saleOrder.code);
        } catch (_) {
          saleOrderDetails = null;
          saleOrderFetchOk = false;
        }

        try {
          packages = await searchShippingPackages(accessToken, saleOrder.code);
          latestPkg = chooseLatestPackage(packages);
        } catch (_) {
          packages = [];
          latestPkg = null;
          packageFetchOk = false;
        }

        const orderId = getUnicommerceOrderId(saleOrder, saleOrderDetails);
        if (!orderId) return null;

        const shipmentStatus = deriveShipmentStatus({
          saleOrder,
          saleOrderDetails,
          packages,
        });

        const isUncertain =
          !saleOrderFetchOk || !packageFetchOk;

        let shopifyOrder = null;
        try {
          shopifyOrder = await findMatchingShopifyOrderByOrderId(orderId);
        } catch (_) {
          shopifyOrder = null;
        }

        return {
          order_id: orderId,
          shipment_status: isUncertain ? STATUS_UNKNOWN : shipmentStatus,
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
          is_uncertain: isUncertain,
          skip_reason: !isUncertain
            ? ""
            : !saleOrderFetchOk
            ? "sale_order_fetch_failed"
            : !packageFetchOk
            ? "shipping_package_fetch_failed"
            : "status_not_allowed",
        };
      }
    );

    const validRows = enrichedRows.filter((row) => row && row.order_id);
    const uncertainRows = validRows.filter((row) => row.is_uncertain);
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
        unknownCount: uncertainRows.length,
        matchedShopifyOrderCount: 0,
        inserted: 0,
        updated: 0,
        sample: [],
        unknownSample: uncertainRows.slice(0, 10),
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
      unknownCount: uncertainRows.length,
      matchedShopifyOrderCount: matchedShopifyCount,
      inserted,
      updated,
      sample: validRows.slice(0, 10),
      unknownSample: uncertainRows.slice(0, 10),
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
