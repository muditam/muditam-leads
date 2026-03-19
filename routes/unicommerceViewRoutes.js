const express = require("express");
const axios = require("axios");

const router = express.Router();

const UNI_BASE = `https://${process.env.UNICOMMERCE_TENANT}.unicommerce.com`;
const UNI_USERNAME = process.env.UNICOMMERCE_USERNAME;
const UNI_PASSWORD = process.env.UNICOMMERCE_PASSWORD;
const UNI_FACILITY = process.env.UNICOMMERCE_FACILITY_CODE || "";

const RAW_PAGE_SIZE = 100;
const MAX_INTERNAL_PAGES = 50;
const ENRICH_CONCURRENCY = 5;

let uniTokenCache = {
  accessToken: null,
  expiresAt: 0,
};

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
    headers: {
      "Content-Type": "application/json",
    },
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

function normalizeOrderId(v = "") {
  return String(v || "").trim().replace(/^#/, "").replace(/^MA/i, "");
}

function formatOrderId(v = "") {
  const id = normalizeOrderId(v);
  return id ? `MA${id}` : "";
}

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function last10(v = "") {
  return digitsOnly(v).slice(-10);
}

function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isShopifyChannel(saleOrder = {}) {
  return String(saleOrder?.channel || "").trim().toLowerCase() === "shopify";
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

function mapShipmentStatus(pkg = {}) {
  const txt = [pkg.status, pkg.trackingStatus, pkg.courierStatus]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (pkg.delivered || txt.includes("delivered")) return "Delivered";
  if (txt.includes("rto delivered")) return "RTO Delivered";
  if (txt.includes("rto") || txt.includes("return")) return "RTO";
  if (pkg.dispatched || txt.includes("transit") || txt.includes("dispatch")) return "In Transit";
  if (txt.includes("hold")) return "On Hold";
  if (txt.includes("cancel")) return "Canceled";

  return pkg.status || pkg.trackingStatus || pkg.courierStatus || "Package Not Found";
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
    const s = String(search).trim();
    const normalizedSearch = normalizeOrderId(s);

    payload.searchOptions.searchKey = normalizedSearch;

    if (/^\d+$/.test(normalizedSearch)) {
      payload.displayOrderCode = normalizedSearch;
    }
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

function extractFullName(saleOrder = {}) {
  const billing = saleOrder.billingAddress || {};
  const shipping = saleOrder.shippingAddress || {};
  const customer = saleOrder.customer || {};
  const addresses = Array.isArray(saleOrder.addresses) ? saleOrder.addresses : [];
  const firstAddress = addresses[0] || {};

  return (
    billing.name ||
    shipping.name ||
    customer.name ||
    firstAddress.name ||
    ""
  );
}

function extractContactNumber(saleOrder = {}, fallbackMobile = "") {
  const billing = saleOrder.billingAddress || {};
  const shipping = saleOrder.shippingAddress || {};
  const customer = saleOrder.customer || {};
  const addresses = Array.isArray(saleOrder.addresses) ? saleOrder.addresses : [];
  const firstAddress = addresses[0] || {};

  return last10(
    billing.phone ||
      shipping.phone ||
      customer.phone ||
      firstAddress.phone ||
      saleOrder.notificationMobile ||
      fallbackMobile ||
      ""
  );
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
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => runner())
  );

  return results;
}

router.get("/shopify-orders-live", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);

    const { startDate, endDate, search } = req.query;

    const accessToken = await getUniwareToken();

    const targetStart = (page - 1) * limit;
    const targetEnd = targetStart + limit;

    let internalPage = 1;
    const filteredOrders = [];

    while (internalPage <= MAX_INTERNAL_PAGES) {
      const rawOrders = await searchSaleOrders({
        accessToken,
        page: internalPage,
        limit: RAW_PAGE_SIZE,
        startDate,
        endDate,
        search,
      });

      if (rawOrders.length === 0) break;

      for (const order of rawOrders) {
        if (isShopifyChannel(order)) {
          filteredOrders.push(order);
        }
      }

      if (rawOrders.length < RAW_PAGE_SIZE) break;
      internalPage += 1;
    }

    const pagedOrders = filteredOrders.slice(targetStart, targetEnd);

    const rows = await mapWithConcurrency(pagedOrders, ENRICH_CONCURRENCY, async (saleOrder) => {
      let saleOrderDetails = null;
      let latestPkg = null;

      try {
        saleOrderDetails = await getSaleOrder(accessToken, saleOrder.code);
      } catch (_) {
        saleOrderDetails = null;
      }

      try {
        const packages = await searchShippingPackages(accessToken, saleOrder.code);
        latestPkg = chooseLatestPackage(packages);
      } catch (_) {
        latestPkg = null;
      }

      return {
        order_id: formatOrderId(saleOrder.displayOrderCode || ""),
        shipment_status: latestPkg ? mapShipmentStatus(latestPkg) : "Package Not Found",
        order_date: saleOrder.displayOrderDateTime || saleOrder.created || null,
        contact_number: extractContactNumber(
          saleOrderDetails || {},
          saleOrder.notificationMobile || ""
        ),
        tracking_number: latestPkg?.trackingNumber || "",
        full_name: extractFullName(saleOrderDetails || {}),
        carrier_title: latestPkg?.shippingProvider || "",
      };
    });

    return res.json({
      success: true,
      totalOrders: filteredOrders.length,
      page,
      limit,
      orders: rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Shopify orders from Unicommerce",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;