const express = require("express");
const RedcliffeWebhookEvent = require("../models/RedcliffeWebhookEvent");

const router = express.Router();

const DEFAULT_BASE_URL = "https://apiqa.redcliffelabs.com";
const baseUrl = String(
  process.env.REDCLIFFE_API_BASE_URL || DEFAULT_BASE_URL
).replace(/\/+$/, "");
const apiKey = String(process.env.REDCLIFFE_API_KEY || "").trim();
const apiKeyHeader = String(
  process.env.REDCLIFFE_API_KEY_HEADER || "key"
).trim();
const authScheme = String(process.env.REDCLIFFE_AUTH_SCHEME || "").trim();
const partnerCode = String(process.env.REDCLIFFE_PARTNER_CODE || "CORP15464").trim();
const partnerName = String(process.env.REDCLIFFE_PARTNER_NAME || "Muditam Ayurveda").trim();
const inboundWebhookAuthKey = String(
  process.env.REDCLIFFE_WEBHOOK_AUTH_KEY || ""
).trim();
const inboundWebhookAuthValue = String(
  process.env.REDCLIFFE_WEBHOOK_AUTH_VALUE || ""
).trim();
const useMockOnAuthFailure = String(
  process.env.REDCLIFFE_USE_MOCK_ON_AUTH_FAILURE || "false"
).trim().toLowerCase() === "true";

const recommendedWebhookTypes = [
  "booking_created",
  "cancelled",
  "rescheduled",
  "phleboassigned",
  "pickup",
  "samplesync",
  "consolidatereport",
  "reportvalues",
  "partialreport",
  "pickup_hold",
  "phlebo_started_journey",
  "phlebo_end_journey",
];

function getBaseHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (partnerCode) {
    headers["partner-code"] = partnerCode;
    headers.partner_code = partnerCode;
    headers["x-partner-code"] = partnerCode;
  }

  if (partnerName) {
    headers["partner-name"] = partnerName;
    headers.partner_name = partnerName;
    headers["x-partner-name"] = partnerName;
  }

  return headers;
}

function buildAuthCandidates() {
  if (!apiKey) {
    return [{ label: "no-auth", headers: getBaseHeaders() }];
  }

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (label, extraHeaders) => {
    const headers = { ...getBaseHeaders(), ...extraHeaders };
    const signature = JSON.stringify(headers);
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push({ label, headers });
  };

  if (authScheme) {
    pushCandidate(`authorization-${authScheme.toLowerCase()}`, {
      Authorization: `${authScheme} ${apiKey}`,
    });
  }

  pushCandidate(`custom-${apiKeyHeader.toLowerCase()}`, {
    [apiKeyHeader]: apiKey,
  });
  pushCandidate("key", { key: apiKey });
  pushCandidate("x-api-key", { "x-api-key": apiKey });
  pushCandidate("authorization-bearer", { Authorization: `Bearer ${apiKey}` });
  pushCandidate("authorization-raw", { Authorization: apiKey });
  pushCandidate("authorization-token", { Authorization: `Token ${apiKey}` });
  pushCandidate("api-key", { "api-key": apiKey });
  pushCandidate("apikey", { apikey: apiKey });

  return candidates;
}

function buildMockResponse(path, query = {}, data = {}) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const dayAfter = new Date(today);
  dayAfter.setDate(today.getDate() + 2);
  const toIso = (value) => value.toISOString().slice(0, 10);

  if (path.includes("/get-partner-location-2-eloc/")) {
    const placeQuery = String(query.place_query || "Delhi").trim();
    return {
      status: "success",
      message: "Mock location search response",
      mocked: true,
      results: [
        {
          type: "SUBLOCALITY",
          eloc: "DELH01",
          placeName: `${placeQuery} Demo Location`,
          placeAddress: `Mock address for ${placeQuery}, New Delhi, Delhi, 110001`,
          address: {
            houseNumber: "",
            houseName: "",
            poi: "",
            street: "",
            subSubLocality: "",
            subLocality: placeQuery,
            locality: "Central Delhi",
            village: "",
            subDistrict: "",
            district: "New Delhi",
            city: "Delhi",
            state: "Delhi",
            pincode: "110001",
          },
        },
      ],
    };
  }

  if (path.includes("/get-partner-loc-2-eloc/")) {
    return {
      latitude: 28.6139,
      longitude: 77.209,
      mocked: true,
    };
  }

  if (path.includes("/get-time-slot-list/")) {
    const collectionDate = String(
      query.collection_date || toIso(tomorrow)
    ).trim();
    return {
      status: "success",
      message: `Mock slots are available on ${collectionDate}`,
      mocked: true,
      results: [
        {
          id: 101,
          available_slot: 4,
          format_24_hrs: {
            start_time: "08:00",
            end_time: "09:00",
          },
          format_12_hrs: {
            start_time: "08:00 AM",
            end_time: "09:00 AM",
          },
        },
        {
          id: 102,
          available_slot: 7,
          format_24_hrs: {
            start_time: "10:00",
            end_time: "11:00",
          },
          format_12_hrs: {
            start_time: "10:00 AM",
            end_time: "11:00 AM",
          },
        },
        {
          id: 103,
          available_slot: 3,
          format_24_hrs: {
            start_time: "12:00",
            end_time: "13:00",
          },
          format_12_hrs: {
            start_time: "12:00 PM",
            end_time: "01:00 PM",
          },
        },
      ],
    };
  }

  if (path === "/api/external/v2/center-create-booking/") {
    return {
      status: "success",
      message:
        "Mock booking created temporary. The slot will be locked for next 30 mins.",
      mocked: true,
      pk: 990001,
      booking_id: 990001,
      booking_type: data.booking_type || "Homedx",
      booking_date: data.booking_date || toIso(today),
      collection_date: data.collection_date || toIso(dayAfter),
      collection_slot: Number(data.collection_slot || 101),
      customer_name: data.customer_name || "Demo Customer",
      customer_age: Number(data.customer_age || 30),
      customer_gender: data.customer_gender || "male",
      customer_email: data.customer_email || "[email protected]",
      customer_phonenumber: data.customer_phonenumber || "9876543210",
      customer_altphonenumber:
        data.customer_altphonenumber || data.customer_phonenumber || "9876543210",
      customer_whatsapppnumber:
        data.customer_whatsapppnumber ||
        data.customer_whatsappnumber ||
        data.customer_phonenumber ||
        "9876543210",
      customer_address: data.customer_address || "Mock address",
      address_line2: data.address_line2 || "",
      customer_landmark: data.customer_landmark || "Mock landmark",
      packages: parsePackageCodes(data.package_code).map((code, index) => ({
        id: 7000 + index,
        name: `Mock package ${code}`,
        code,
        package_price: 999,
        offer_price: 799,
        is_addon: false,
      })),
      booking_status: "order booked",
      slot_time: {
        id: Number(data.collection_slot || 101),
        slot: "08:00:00-09:00:00",
      },
      is_credit: Boolean(data.is_credit),
      pincode: String(data.pincode || "110001"),
      reference_data: data.reference_data || "",
    };
  }

  if (path === "/api/external/v2/center-confirm-booking/") {
    return {
      status: "Success",
      message: data.is_confirmed
        ? "Mock booking has been created successfully"
        : "Mock booking has been cancelled",
      mocked: true,
      booking_id: Number(data.booking_id || 990001),
      booking_status: data.is_confirmed ? "confirmed" : "cancelled",
      payment_detail: {
        is_credit: true,
        amount_collected: 799,
      },
    };
  }

  return null;
}

function isUpstreamAuthFailure(result) {
  const message = String(
    result?.data?.message ||
      result?.data?.detail ||
      ""
  ).toLowerCase();

  return (
    result?.status === 401 ||
    (
      result?.status === 400 &&
      (
        message.includes("valid key") ||
        message.includes("authentication") ||
        message.includes("unauthorized") ||
        message.includes("credentials")
      )
    )
  );
}

async function proxyRedcliffeRequest({ method, path, params, data }) {
  if (!apiKey) {
    return {
      status: 500,
      data: {
        status: "failure",
        message: "Redcliffe API key is not configured on the server.",
      },
    };
  }

  const authCandidates = buildAuthCandidates();
  const failures = [];

  try {
    for (const candidate of authCandidates) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: candidate.headers,
        body: data ? JSON.stringify(data) : undefined,
      });

      const responseText = await response.text();
      let parsed;

      try {
        parsed = responseText ? JSON.parse(responseText) : {};
      } catch (_) {
        parsed = {
          status: response.ok ? "success" : "failure",
          message: responseText || "Unexpected Redcliffe response",
        };
      }

      if (response.ok) {
        return {
          status: response.status,
          data: parsed,
        };
      }

      failures.push({
        mode: candidate.label,
        status: response.status,
        body: parsed,
      });

      if (!isUpstreamAuthFailure({ status: response.status, data: parsed })) {
        return {
          status: response.status,
          data: parsed,
        };
      }
    }

    return {
      status: 401,
      data: {
        status: "failure",
        message:
          "Redcliffe upstream authentication failed. The configured credential was rejected by every supported auth mode.",
        attempted_auth_modes: failures.map((item) => item.mode),
        upstream_failures: failures,
      },
    };
  } catch (error) {
    console.error("Redcliffe proxy error:", error.message);
    return {
      status: 502,
      data: {
        status: "failure",
        message: "Unable to reach Redcliffe API",
        error: error.message,
      },
    };
  }
}

async function proxyWithMockFallback({ method, path, query, data }) {
  const result = await proxyRedcliffeRequest({
    method,
    path,
    params: query,
    data,
  });

  if (useMockOnAuthFailure && isUpstreamAuthFailure(result)) {
    const mocked = buildMockResponse(path, query, data);
    if (mocked) {
      return {
        status: 200,
        data: mocked,
      };
    }
  }

  return result;
}

function withQuery(path, query = {}) {
  const url = new URL(`${baseUrl}${path}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  return `${url.pathname}${url.search}`;
}

function parsePackageCodes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function toDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getPhoneTail(value) {
  const digits = toDigits(value);
  return digits ? digits.slice(-10) : "";
}

function normalizeStatusValue(value) {
  if (value && typeof value === "object") {
    const raw = value.value || value.name || value.status || "";
    const id = value.id ?? null;
    return {
      id,
      value: String(raw || ""),
      label: String(raw || ""),
    };
  }

  const text = String(value || "");
  return {
    id: null,
    value: text,
    label: text,
  };
}

function buildStatusSummary(items, accessor) {
  return items.reduce((acc, item) => {
    const value = String(accessor(item) || "unknown").trim() || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function summarizeReports(reportList) {
  const reports = toArray(reportList).filter(Boolean);
  const statuses = reports
    .map((item) => String(item?.status || "").trim())
    .filter(Boolean);
  const links = reports
    .map((item) => String(item?.report_link || "").trim())
    .filter(Boolean);
  const latestStatus = statuses[statuses.length - 1] || "none";

  return {
    total: reports.length,
    latestStatus,
    statuses,
    available: links.length > 0,
    links,
  };
}

function normalizePatients(patientDetail) {
  return toArray(patientDetail).map((patient) => {
    const packages = toArray(patient?.package).map((pkg) => ({
      code: String(pkg?.code || "").trim(),
      name: String(pkg?.name || "").trim(),
      packagePrice: pkg?.package_price ?? null,
      offerPrice: pkg?.offer_price ?? null,
    }));

    return {
      patientId: patient?.patient_id ?? null,
      customerName: String(patient?.customer_name || "").trim(),
      age: patient?.age ?? null,
      gender: String(patient?.gender || "").trim(),
      packages,
    };
  });
}

function normalizeBookingRecord(item = {}) {
  const rootPackages = toArray(item.packages).map((pkg) => ({
    code: String(pkg?.code || "").trim(),
    name: String(pkg?.name || "").trim(),
    packagePrice: pkg?.package_price ?? null,
    offerPrice: pkg?.offer_price ?? null,
  }));
  const fallbackPatient =
    item.customer_name || rootPackages.length
      ? [
          {
            patientId: item.patientId ?? null,
            customerName: String(item.customer_name || "").trim(),
            age: item.customer_age ?? null,
            gender: String(item.customer_gender || "").trim(),
            packages: rootPackages,
          },
        ]
      : [];
  const patients = normalizePatients(item.patient_detail);
  const normalizedPatients = patients.length ? patients : fallbackPatient;
  const flatPackages = normalizedPatients.flatMap((patient) => patient.packages);
  const bookingStatus = normalizeStatusValue(item.booking_status);
  const reportSummary = summarizeReports(item.report);

  return {
    bookingId: item.booking_id ?? item.pk ?? null,
    referenceData: String(
      item.client_ref_id || item.reference_data || item.client_refid || ""
    ).trim(),
    bookingDate: item.booking_date || "",
    collectionDate: item.collection_date || "",
    collectionSlot: item.collection_slot ?? null,
    collectionTime: {
      slot12Hours: item.collection_time?.slot_12_hrs || "",
      slot24Hours: item.collection_time?.slot_24_hrs || "",
      raw: item.collection_time || null,
    },
    bookingStatus,
    pickupStatus: String(item.pickup_status || "").trim() || "unknown",
    reportStatus: String(item.report_status || reportSummary.latestStatus || "none"),
    customerPhone: String(item.customer_phone || item.customer_phonenumber || "").trim(),
    phoneTail: getPhoneTail(item.customer_phone || item.customer_phonenumber || ""),
    address: String(item.address || item.customer_address || "").trim(),
    landmark: String(item.landmark || item.customer_landmark || "").trim(),
    city: String(item.city || "").trim(),
    state: String(item.state || "").trim(),
    pincode: String(
      item.pincode ||
        item.customer_areapincode?.pincode ||
        item.customer_areapincode?.area ||
        ""
    ).trim(),
    phleboDetail: {
      name: String(item.phlebo_detail?.name || item.phlebo_details?.name || "").trim(),
      contact: String(item.phlebo_detail?.contact || item.phlebo_details?.contact || "").trim(),
      raw: item.phlebo_detail || item.phlebo_details || {},
    },
    paymentDetail: item.payment_detail || null,
    patients: normalizedPatients,
    packages: flatPackages,
    reportSummary,
    report: toArray(item.report),
    raw: item,
  };
}

function filterBookings(records, filters = {}) {
  const phoneTail = getPhoneTail(filters.phone || filters.customer_phone || "");
  const packageCodes = parsePackageCodes(filters.package_code);
  const clientRef = String(filters.client_ref_id || filters.reference_data || "").trim().toLowerCase();

  return records.filter((item) => {
    if (phoneTail && item.phoneTail !== phoneTail) return false;

    if (clientRef) {
      const candidate = String(item.referenceData || "").trim().toLowerCase();
      if (!candidate.includes(clientRef)) return false;
    }

    if (packageCodes.length) {
      const packageSet = new Set(item.packages.map((pkg) => String(pkg.code || "").trim().toLowerCase()));
      const hasAllCodes = packageCodes.every((code) => packageSet.has(code.toLowerCase()));
      if (!hasAllCodes) return false;
    }

    return true;
  });
}

function normalizeWebhookEntry(entry = {}) {
  return {
    id: entry.id ?? null,
    hookType: {
      id: entry.hook_type_data?.id ?? entry.hook_type ?? null,
      name: String(entry.hook_type_data?.name || "").trim(),
      description: String(entry.hook_type_data?.description || "").trim(),
    },
    urlLink: String(entry.url_link || "").trim(),
    authKey: entry.webhook_auth_key || null,
    authValue: entry.webhook_auth_value || null,
    center: entry.center ?? null,
    createdAt: entry.created_at || null,
    updatedAt: entry.updated_at || null,
    raw: entry,
  };
}

function normalizePackageDetailsResponse(data = {}) {
  const groups = toArray(data.data).map((group) => ({
    name: String(group?.name || "").trim(),
    tests: toArray(group?.package_detail).map((item) => String(item?.name || "").trim()).filter(Boolean),
  }));

  return {
    status: data.status || "success",
    message: data.message || "",
    package: {
      code: String(data.code || "").trim(),
      name: String(data.name || "").trim(),
      groups,
      totalParameters: groups.reduce((sum, group) => sum + group.tests.length, 0),
    },
    raw: data,
  };
}

function normalizeTestStatusResponse(data = {}) {
  const payload = data.data || {};
  return {
    status: data.status || "success",
    message: data.message || "",
    data: {
      bookingId: String(payload.booking_id || "").trim(),
      pendingTests: toArray(payload.pending_tests).map(String),
      dismissedTests: toArray(payload.dismissed_tests).map(String),
      completedTests: toArray(payload.completed_tests).map(String),
      rejectedTests: toArray(payload.rejected_tests).map(String),
      totalTests: toArray(payload.total_tests).map(String),
    },
    raw: data,
  };
}

function normalizeWebhookLogs(logs) {
  return logs.map((log) => ({
    id: String(log._id),
    hookType: log.hookType || "",
    deliveryStatus: log.deliveryStatus,
    authVerified: Boolean(log.authVerified),
    processingError: log.processingError || "",
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    payload: log.payload,
  }));
}

function getRequestHeadersSnapshot(headers = {}) {
  const snapshot = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (typeof value === "string") {
      snapshot[key] = value;
    }
  });
  return snapshot;
}

async function recordWebhookEvent({
  payload,
  hookType,
  deliveryStatus,
  authVerified,
  processingError,
  req,
}) {
  try {
    const created = await RedcliffeWebhookEvent.create({
      hookType,
      deliveryStatus,
      authVerified,
      processingError: processingError || "",
      requestHeaders: getRequestHeadersSnapshot(req.headers),
      payload,
      meta: {
        ip: req.ip || req.socket?.remoteAddress || "",
        userAgent: String(req.get("user-agent") || ""),
        method: req.method,
        path: req.originalUrl,
      },
    });
    return created;
  } catch (error) {
    console.error("Failed to persist Redcliffe webhook event:", error.message);
    return null;
  }
}

function getInboundWebhookAuthState(req) {
  if (!inboundWebhookAuthKey || !inboundWebhookAuthValue) {
    return {
      required: false,
      verified: true,
      message: "",
    };
  }

  const actual = req.get(inboundWebhookAuthKey) || req.headers[inboundWebhookAuthKey.toLowerCase()];
  const verified = String(actual || "") === inboundWebhookAuthValue;

  return {
    required: true,
    verified,
    message: verified ? "" : `Invalid webhook authentication for header ${inboundWebhookAuthKey}`,
  };
}

function isHtmlLikeMessage(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("<!doctype html>") || text.includes("<html>");
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  return members.map((member) => ({
    ...member,
    customerAge:
      member.customerAge !== undefined && member.customerAge !== ""
        ? Number(member.customerAge)
        : member.customerAge,
    packageCode: parsePackageCodes(member.packageCode),
  }));
}

function normalizeCreateBookingPayload(body = {}) {
  const whatsappNumber =
    body.customer_whatsappnumber ||
    body.customer_whatsapppnumber ||
    body.customer_phonenumber ||
    "";

  const payload = {
    booking_date: body.booking_date,
    collection_date: body.collection_date,
    collection_slot:
      body.collection_slot !== undefined && body.collection_slot !== ""
        ? Number(body.collection_slot)
        : body.collection_slot,
    package_code: parsePackageCodes(body.package_code),
    customer_name: body.customer_name,
    customer_age:
      body.customer_age !== undefined && body.customer_age !== ""
        ? Number(body.customer_age)
        : body.customer_age,
    customer_gender: body.customer_gender,
    customer_email: body.customer_email || body.email,
    customer_phonenumber: body.customer_phonenumber,
    customer_altphonenumber:
      body.customer_altphonenumber || body.customer_phonenumber,
    customer_whatsappnumber: whatsappNumber,
    customer_whatsapppnumber: whatsappNumber,
    customer_address: body.customer_address,
    address_line2: body.address_line2 || body.addressLine2 || "",
    customer_landmark: body.customer_landmark,
    pincode: String(body.pincode || ""),
    is_credit: Boolean(body.is_credit),
    booking_type: body.booking_type || "Homedx",
    reference_data: body.reference_data || "",
    customer_longitude:
      body.customer_longitude !== undefined && body.customer_longitude !== ""
        ? Number(body.customer_longitude)
        : body.customer_longitude,
    customer_latitude:
      body.customer_latitude !== undefined && body.customer_latitude !== ""
        ? Number(body.customer_latitude)
        : body.customer_latitude,
    additional_member: normalizeMembers(body.additional_member),
    customer_type: body.customer_type || "normal",
  };

  if (body.center_discount !== undefined && body.center_discount !== "") {
    payload.center_discount = Number(body.center_discount);
  }

  if (body.client_refid || body.Client_refid) {
    payload.client_refid = body.client_refid || body.Client_refid;
  }

  return payload;
}

router.get("/location-search", async (req, res) => {
  const placeQuery = String(req.query.place_query || "").trim();

  if (!placeQuery) {
    return res.status(400).json({
      status: "failure",
      message: "place_query is required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/partner/v2/get-partner-location-2-eloc/", {
      place_query: placeQuery,
    }),
    query: {
      place_query: placeQuery,
    },
  });

  return res.status(result.status).json(result.data);
});

router.get("/location-by-eloc", async (req, res) => {
  const eloc = String(req.query.eloc || "").trim();

  if (!eloc) {
    return res.status(400).json({
      status: "failure",
      message: "eloc is required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/partner/v2/get-partner-loc-2-eloc/", {
      eloc,
    }),
    query: {
      eloc,
    },
  });

  return res.status(result.status).json(result.data);
});

router.get("/time-slots", async (req, res) => {
  const { collection_date, latitude, longitude, customer_gender } = req.query;

  if (!collection_date || latitude === undefined || longitude === undefined) {
    return res.status(400).json({
      status: "failure",
      message: "collection_date, latitude and longitude are required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/booking/v2/get-time-slot-list/", {
      collection_date,
      latitude,
      longitude,
      customer_gender,
    }),
    query: {
      collection_date,
      latitude,
      longitude,
      customer_gender,
    },
  });

  return res.status(result.status).json(result.data);
});

router.post("/bookings/create", async (req, res) => {
  const payload = normalizeCreateBookingPayload(req.body || {});

  const requiredFields = [
    "booking_date",
    "collection_date",
    "collection_slot",
    "customer_name",
    "customer_age",
    "customer_gender",
    "customer_email",
    "customer_phonenumber",
    "customer_address",
    "customer_landmark",
    "pincode",
    "customer_latitude",
    "customer_longitude",
  ];

  const missingField = requiredFields.find((field) => {
    const value = payload[field];
    return value === undefined || value === null || value === "";
  });

  if (missingField) {
    return res.status(400).json({
      status: "failure",
      message: `${missingField} is required`,
    });
  }

  if (!payload.package_code.length) {
    return res.status(400).json({
      status: "failure",
      message: "At least one package code is required",
    });
  }

  if (!Number.isFinite(Number(payload.collection_slot)) || Number(payload.collection_slot) <= 0) {
    return res.status(400).json({
      status: "failure",
      message: "A valid collection_slot is required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "POST",
    path: "/api/external/v2/center-create-booking/",
    data: payload,
  });

  return res.status(result.status).json(result.data);
});

router.post("/bookings/confirm", async (req, res) => {
  const { booking_id, is_confirmed } = req.body || {};

  if (!booking_id && booking_id !== 0) {
    return res.status(400).json({
      status: "failure",
      message: "booking_id is required",
    });
  }

  if (typeof is_confirmed !== "boolean") {
    return res.status(400).json({
      status: "failure",
      message: "is_confirmed must be boolean",
    });
  }

  const payload = {
    booking_id,
    is_confirmed,
  };

  const result = await proxyWithMockFallback({
    method: "POST",
    path: "/api/external/v2/center-confirm-booking/",
    data: payload,
  });
 
  return res.status(result.status).json(result.data);
});

router.get("/bookings", async (req, res) => {
  const upstreamQuery = {
    booking_id: req.query.booking_id,
    client_ref_id: req.query.client_ref_id || req.query.reference_data,
    booking_status: req.query.booking_status,
    booking_date: req.query.booking_date,
    collection_date: req.query.collection_date,
  };

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/external/v2/center-get-booking", upstreamQuery),
    query: upstreamQuery,
  });

  if (result.status >= 400) {
    return res.status(result.status).json(result.data);
  }

  const upstreamRecords = Array.isArray(result.data)
    ? result.data
    : toArray(result.data?.data);
  const normalized = upstreamRecords.map(normalizeBookingRecord);
  const filtered = filterBookings(normalized, req.query || {});

  return res.status(200).json({
    status: result.data?.status || "success",
    message: result.data?.message || "Booking details fetched successfully",
    count: filtered.length,
    summary: {
      total: filtered.length,
      bookingStatus: buildStatusSummary(filtered, (item) => item.bookingStatus.value || "unknown"),
      pickupStatus: buildStatusSummary(filtered, (item) => item.pickupStatus || "unknown"),
      reportStatus: buildStatusSummary(filtered, (item) => item.reportStatus || "none"),
    },
    results: filtered,
    raw: result.data,
  });
});

router.get("/bookings/:bookingId/test-status", async (req, res) => {
  const bookingId = String(req.params.bookingId || "").trim();

  if (!bookingId) {
    return res.status(400).json({
      status: "failure",
      message: "bookingId is required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/external/v2/booking-test-status", {
      booking_id: bookingId,
    }),
    query: {
      booking_id: bookingId,
    },
  });

  if (result.status >= 400) {
    if (result.status === 404 && isHtmlLikeMessage(result.data?.message)) {
      return res.status(404).json({
        status: "failure",
        message: "Redcliffe booking test status endpoint is unavailable on the current environment.",
      });
    }
    return res.status(result.status).json(result.data);
  }

  return res.status(200).json(normalizeTestStatusResponse(result.data));
});

router.get("/packages/:code/details", async (req, res) => {
  const code = String(req.params.code || "").trim();

  if (!code) {
    return res.status(400).json({
      status: "failure", 
      message: "package code is required",
    });
  }

  const result = await proxyWithMockFallback({
    method: "GET",
    path: withQuery("/api/external/v2/package-parameter-data/", {
      code,
    }),
    query: { code },
  });

  if (result.status >= 400) {
    if (result.status === 404 && isHtmlLikeMessage(result.data?.message)) {
      return res.status(404).json({
        status: "failure",
        message: "Redcliffe package detail endpoint is unavailable on the current environment.",
      });
    }
    return res.status(result.status).json({
      ...result.data,
      message:
        result.data?.message ||
        "Unable to fetch package details. This Redcliffe endpoint may only be available on production.",
    });
  }

  return res.status(200).json(normalizePackageDetailsResponse(result.data));
});

router.get("/webhooks", async (_req, res) => {
  const result = await proxyWithMockFallback({
    method: "GET",
    path: "/api/v1/webhook/list-added-webhooks/",
  });

  if (result.status >= 400) {
    return res.status(result.status).json(result.data);
  }

  const entries = toArray(result.data?.results).map(normalizeWebhookEntry);

  return res.status(200).json({
    status: result.data?.status || "success",
    message: result.data?.message || "Webhook list fetched successfully",
    count: entries.length,
    recommendedHookTypes: recommendedWebhookTypes,
    results: entries,
    raw: result.data,
  });
});

router.get("/webhooks/logs", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const logs = await RedcliffeWebhookEvent.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return res.status(200).json({
    status: "success",
    count: logs.length,
    results: normalizeWebhookLogs(logs),
  });
});

router.post("/webhooks/register", async (req, res) => {
  const urlLink = String(req.body?.url_link || "").trim();
  const hookTypeList = toArray(req.body?.hook_type_list).map((item) =>
    String(item || "").trim()
  ).filter(Boolean);
  const authKey = String(req.body?.auth_key || "").trim();
  const authValue = String(req.body?.auth_value || "").trim();

  if (!urlLink) {
    return res.status(400).json({
      status: "failure",
      message: "url_link is required",
    });
  }

  if (!hookTypeList.length) {
    return res.status(400).json({
      status: "failure",
      message: "At least one hook type is required",
    });
  }

  if (authKey && !authValue) {
    return res.status(400).json({
      status: "failure",
      message: "auth_value is required when auth_key is provided",
    });
  }

  const payload = {
    url_link: urlLink,
    hook_type_list: hookTypeList,
  };

  if (authKey) {
    payload.auth_key = authKey;
    payload.auth_value = authValue;
  }

  const result = await proxyWithMockFallback({
    method: "POST",
    path: "/api/v1/webhook/create-update-webhook/",
    data: payload,
  });

  return res.status(result.status).json({
    ...result.data,
    configuredHookTypes: hookTypeList,
    urlLink,
  });
});

router.post("/webhooks/redcliffe", async (req, res) => {
  const payload = req.body || {};
  const hookType = String(
    payload.hook_type ||
      payload.hookType ||
      payload.trigger ||
      payload.event ||
      payload.type ||
      ""
  ).trim();
  const authState = getInboundWebhookAuthState(req);
  const status = authState.verified ? "processed" : "rejected";

  await recordWebhookEvent({
    payload,
    hookType,
    deliveryStatus: status,
    authVerified: authState.verified,
    processingError: authState.message,
    req,
  });

  if (!authState.verified) {
    return res.status(401).json({
      status: "failure",
      message: authState.message,
    });
  }

  return res.status(200).json({
    status: "success",
    message: "Webhook received",
    hookType,
  });
});

module.exports = router;
