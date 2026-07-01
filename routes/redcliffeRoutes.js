const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const RedcliffeWebhookEvent = require("../models/RedcliffeWebhookEvent");
const RedcliffeBooking = require("../models/RedcliffeBooking");
const RedcliffePaymentIntent = require("../models/RedcliffePaymentIntent");

const router = express.Router();
const webhookRouter = express.Router();

const DEFAULT_BASE_URL = "https://apiv3.redcliffelabs.com";
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
const RECENT_BOOKING_SYNC_DAYS = 5;
const RECENT_BOOKING_SYNC_TTL_MS = 5 * 60 * 1000;
const recentBookingSyncState = {
 inFlight: null,
 lastSuccessAt: 0,
};


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
     customer_email: data.customer_email || "[email protected]",
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


 if (path.includes("/api/external/v2/center-get-booking")) {
   const bookingId = Number(query.booking_id || 990001);
   const bookingDate = String(query.booking_date || toIso(today)).trim();
   const collectionDate = String(query.collection_date || toIso(dayAfter)).trim();
   const customerPhone = "9876543210";
   return {
     status: "success",
     message: "Mock booking details fetched successfully",
     mocked: true,
     data: [
       {
         booking_id: bookingId,
         booking_date: bookingDate,
         collection_date: collectionDate,
         customer_name: "Demo Customer",
         customer_age: 30,
         customer_gender: "male",
         customer_phonenumber: customerPhone,
         customer_address: "Mock address",
         customer_landmark: "Mock landmark",
         city: "Delhi",
         state: "Delhi",
         pincode: "110001",
         booking_status: "order booked",
         pickup_status: "pending",
         report_status: "none",
         collection_slot: 101,
         slot_time: {
           id: 101,
           slot: "08:00:00-09:00:00",
         },
         package_detail: [],
         packages: [
           {
             id: 7001,
             name: "Mock package CBC",
             code: "CBC",
             package_price: 999,
             offer_price: 799,
             is_addon: false,
           },
         ],
         report: [],
         reference_data: String(query.client_ref_id || "").trim(),
       },
     ],
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


 if (path === "/api/external/v2/center-update-booking/") {
   const nextStatus = String(data.booking_status || "").trim().toLowerCase();
   return {
     status: "success",
     message:
       nextStatus === "rescheduled"
         ? "Mock booking is rescheduled"
         : "Mock booking is cancelled",
     mocked: true,
     booking_id: Number(data.booking_id || 990001),
     booking_status: nextStatus || "updated",
     details:
       nextStatus === "rescheduled"
         ? {
             collection_date: data.collection_date || toIso(dayAfter),
             collection_slot: String(data.collection_slot || "08:00:00-09:00:00"),
           }
         : {},
   };
 }


 if (path.includes("/api/external/v2/open-add-member/")) {
   const incomingMembers = toArray(data.additional_member).map((member, index) => ({
     id: 900000 + index,
     customer_name: member.customer_name || member.customerName || "",
     customer_age: member.customer_age || member.customerAge || "",
     customer_gender: member.customer_gender || member.customerGender || "",
     packages: parsePackageCodes(member.package_code || member.packageCode).map((code, pkgIndex) => ({
       id: 980000 + pkgIndex,
       name: `Mock package ${code}`,
       code,
     })),
   }));


   return {
     status: "success",
     message: `${incomingMembers.length} member(s) have been added succesfully`,
     mocked: true,
     booking_id: Number(path.split("/").filter(Boolean).pop() || 990001),
     additional_members: incomingMembers,
   };
 }


 if (path.includes("/api/external/v2/get-consolidated-report/")) {
   const bookingId = path.split("/").filter(Boolean).pop() || "990001";
   return {
     status: "success",
     message: "Mock consolidated report fetched",
     mocked: true,
     booking_id: bookingId,
     report_url: `https://example.com/mock-consolidated-report-${bookingId}.pdf`,
   };
 }


 if (path.includes("/api/external/v2/get-digital-report/")) {
   const bookingId = path.split("/").filter(Boolean).pop() || "990001";
   return {
     status: "success",
     message: "Mock digital report fetched",
     mocked: true,
     booking_id: bookingId,
     report_url: `https://example.com/mock-digital-report-${bookingId}.pdf`,
     test_values: [],
   };
 }


 return null;
}

function toIsoDate(value = new Date()) {
 return new Date(value).toISOString().slice(0, 10);
}

function getRecentIsoDates(days = RECENT_BOOKING_SYNC_DAYS) {
 const dates = [];
 const today = new Date();
 for (let offset = 0; offset < days; offset += 1) {
   const current = new Date(today);
   current.setDate(today.getDate() - offset);
   dates.push(toIsoDate(current));
 }
 return dates.reverse();
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


 const canUseMockFallback =
   isUpstreamAuthFailure(result) ||
   (result?.status === 500 &&
     String(result?.data?.message || "")
       .toLowerCase()
       .includes("api key is not configured"));


 if (useMockOnAuthFailure && canUseMockFallback) {
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

function getNormalizedStatusText(value) {
 const raw =
   value && typeof value === "object"
     ? value.value || value.name || value.status || ""
     : value;
 return String(raw || "").trim().toLowerCase();
}

function shouldPreserveConfirmedStatus(existingStatus, incomingStatus) {
 const existing = getNormalizedStatusText(existingStatus);
 const incoming = getNormalizedStatusText(incomingStatus);
 if (!existing.includes("confirm")) return false;
 return incoming === "order booked" || incoming === "booked";
}

function mergeBookingStatusWithExisting(nextItem, existingItem) {
 if (!existingItem) return nextItem;
 if (!shouldPreserveConfirmedStatus(existingItem.bookingStatus, nextItem.bookingStatus)) {
   return nextItem;
 }
 return {
   ...nextItem,
   bookingStatus: existingItem.bookingStatus,
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
   .map((item) =>
     String(
       item?.report_link ||
         item?.report_url ||
         item?.url ||
         item?.link ||
         ""
     ).trim()
   )
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

function extractReportUrl(payload, visited = new Set()) {
 if (typeof payload === "string") {
   const value = payload.trim();
   return /^https?:\/\//i.test(value) ? value : "";
 }
 if (!payload || typeof payload !== "object") return "";
 if (visited.has(payload)) return "";
 visited.add(payload);

 const directKeys = [
   "report_url",
   "reportUrl",
   "report_link",
   "reportLink",
   "digital_report_url",
   "consolidated_report_url",
   "url",
   "link",
   "pdf_url",
   "pdfUrl",
   "file_url",
   "fileUrl",
 ];

 for (const key of directKeys) {
   const value = payload[key];
   if (typeof value === "string" && value.trim()) {
     return value.trim();
   }
 }

 if (typeof payload.message === "string" && /^https?:\/\//i.test(payload.message.trim())) {
   return payload.message.trim();
 }

 if (Array.isArray(payload)) {
   for (const item of payload) {
     const nested = extractReportUrl(item, visited);
     if (nested) return nested;
   }
   return "";
 }

 const nestedKeys = [
   "data",
   "details",
   "payload",
   "result",
   "report",
   "reports",
   "results",
 ];

 for (const key of nestedKeys) {
   const nested = extractReportUrl(payload[key], visited);
   if (nested) return nested;
 }

 for (const value of Object.values(payload)) {
   const nested = extractReportUrl(value, visited);
   if (nested) return nested;
 }

 return "";
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


function normalizeAdditionalMembers(additionalMembers) {
 return toArray(additionalMembers).map((member) => {
   const packages = toArray(member?.packages || member?.package || member?.package_detail).map((pkg) => ({
     code: String(pkg?.code || "").trim(),
     name: String(pkg?.name || "").trim(),
     packagePrice: pkg?.package_price ?? null,
     offerPrice: pkg?.offer_price ?? null,
   }));


   return {
     patientId: member?.patient_id ?? member?.id ?? null,
     customerName: String(member?.customer_name || member?.customerName || "").trim(),
     age: member?.age ?? member?.customer_age ?? member?.customerAge ?? null,
     gender: String(member?.gender || member?.customer_gender || member?.customerGender || "").trim(),
     packages,
   };
 }).filter((member) => member.customerName || member.packages.length);
}


function stringifySlotValue(value) {
 if (value === undefined || value === null) return "";
 if (typeof value === "string") return value.trim();
 if (typeof value === "number") return String(value);
 return "";
}


function normalizeCollectionSlot(item = {}) {
 const collectionTime = item.collection_time && typeof item.collection_time === "object"
   ? item.collection_time
   : {};
 const slotTime = item.slot_time && typeof item.slot_time === "object"
   ? item.slot_time
   : {};
 const collectionSlotRaw = item.collection_slot;
 const collectionSlotObject =
   collectionSlotRaw && typeof collectionSlotRaw === "object" ? collectionSlotRaw : {};


 const slot12Hours =
   stringifySlotValue(collectionTime.slot_12_hrs) ||
   stringifySlotValue(slotTime.slot_12_hrs) ||
   stringifySlotValue(collectionSlotObject.slot_12_hrs);


 const slot24Hours =
   stringifySlotValue(collectionTime.slot_24_hrs) ||
   stringifySlotValue(slotTime.slot_24_hrs) ||
   stringifySlotValue(collectionSlotObject.slot_24_hrs);


 const slotText =
   stringifySlotValue(slotTime.slot) ||
   stringifySlotValue(collectionTime.slot) ||
   stringifySlotValue(collectionSlotObject.slot);


 const slotId =
   collectionSlotObject.id ??
   slotTime.id ??
   collectionTime.id ??
   (typeof collectionSlotRaw === "string" || typeof collectionSlotRaw === "number"
     ? collectionSlotRaw
     : null);


 const display =
   slot12Hours ||
   slot24Hours ||
   slotText ||
   (slotId !== undefined && slotId !== null && String(slotId).trim() !== ""
     ? `Slot ${String(slotId).trim()}`
     : "NA");


 return {
   collectionSlotId:
     slotId !== undefined && slotId !== null && String(slotId).trim() !== ""
       ? String(slotId).trim()
       : null,
   collectionSlotRaw: collectionSlotRaw ?? null,
   collectionTime: {
     slot12Hours,
     slot24Hours,
     display,
     raw: Object.keys(collectionTime).length
       ? collectionTime
       : Object.keys(slotTime).length
         ? slotTime
         : null,
   },
 };
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
 const additionalMembers = normalizeAdditionalMembers(
   item.additional_members || item.additional_member
 );
 const basePatients = patients.length ? patients : fallbackPatient;
 const normalizedPatients = [...basePatients, ...additionalMembers];
 const flatPackages = normalizedPatients.flatMap((patient) => patient.packages);
 const bookingStatus = normalizeStatusValue(item.booking_status);
 const reportSummary = summarizeReports(item.report);
 const slotMeta = normalizeCollectionSlot(item);
 const compactRaw = {
   booking_id: item.booking_id ?? item.pk ?? null,
   collection_slot:
     item.collection_slot && typeof item.collection_slot === "object"
       ? item.collection_slot
       : null,
   slot_time:
     item.slot_time && typeof item.slot_time === "object" ? item.slot_time : null,
   collection_time:
     item.collection_time && typeof item.collection_time === "object"
       ? item.collection_time
       : null,
 };


 return {
   bookingId: item.booking_id ?? item.pk ?? null,
   orderId: String(
     item.order_id ||
       item.orderId ||
       item.shopify_order_id ||
       item.client_ref_id ||
       item.reference_data ||
       item.client_refid ||
       ""
   ).trim(),
   referenceData: String(
     item.client_ref_id || item.reference_data || item.client_refid || ""
   ).trim(),
   bookingDate: item.booking_date || "",
   collectionDate: item.collection_date || "",
   collectionSlot: slotMeta.collectionSlotRaw,
   collectionSlotId: slotMeta.collectionSlotId,
   collectionTime: slotMeta.collectionTime,
   bookingStatus,
   pickupStatus: String(item.pickup_status || "").trim() || "unknown",
   reportStatus: String(item.report_status || reportSummary.latestStatus || "none"),
   customerPhone: String(item.customer_phone || item.customer_phonenumber || "").trim(),
   phoneTail: getPhoneTail(item.customer_phone || item.customer_phonenumber || ""),
   address: String(item.address || item.customer_address || "").trim(),
   landmark: String(item.landmark || item.customer_landmark || "").trim(),
   city: String(item.city || "").trim(),
   state: String(item.state || "").trim(),
   latitude: String(
     item.customer_latitude || item.latitude || item.customer_location?.latitude || ""
   ).trim(),
   longitude: String(
     item.customer_longitude || item.longitude || item.customer_location?.longitude || ""
   ).trim(),
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
   raw: compactRaw,
 };
}

function getWebhookBookingPayload(payload = {}) {
 const nestedContainers = [
   payload.data,
   payload.details,
   payload.payload,
   payload.result,
 ];

 for (const container of nestedContainers) {
   if (container && typeof container === "object" && !Array.isArray(container)) {
     const bookingId = extractBookingIdFromPayload(container);
     if (bookingId) return container;
   }
 }

 return payload && typeof payload === "object" ? payload : {};
}

function buildBookingPatchFromPayload(payload = {}, source = "unknown") {
 const snapshot = payload && typeof payload === "object" ? payload : {};
 const bookingId = extractBookingIdFromPayload(snapshot);
 if (!bookingId) return null;

 const looksLikeFullBooking =
   snapshot.booking_date ||
   snapshot.collection_date ||
   snapshot.customer_name ||
   snapshot.customer_phonenumber ||
   snapshot.customer_phone ||
   snapshot.packages ||
   snapshot.patient_detail ||
   snapshot.additional_members ||
   snapshot.collection_slot ||
   snapshot.slot_time;

 if (looksLikeFullBooking) {
   const normalized = normalizeBookingRecord(snapshot);
   return {
     ...normalized,
     bookingId: String(normalized.bookingId || bookingId).trim(),
     lastSource: source,
     lastSyncedAt: new Date(),
   };
 }

 const patch = {
   bookingId: String(bookingId).trim(),
   lastSource: source,
   lastSyncedAt: new Date(),
 };

 if (snapshot.booking_status !== undefined) {
   patch.bookingStatus = normalizeStatusValue(snapshot.booking_status);
 }
 if (snapshot.pickup_status !== undefined) {
   patch.pickupStatus = String(snapshot.pickup_status || "").trim() || "unknown";
 }
 if (snapshot.report_status !== undefined) {
   patch.reportStatus = String(snapshot.report_status || "").trim() || "none";
 }
 if (snapshot.collection_date !== undefined) {
   patch.collectionDate = String(snapshot.collection_date || "").trim();
 }
 if (snapshot.collection_slot !== undefined || snapshot.slot_time !== undefined || snapshot.collection_time !== undefined) {
   const slotMeta = normalizeCollectionSlot(snapshot);
   patch.collectionSlot = slotMeta.collectionSlotRaw;
   patch.collectionSlotId = slotMeta.collectionSlotId;
   patch.collectionTime = slotMeta.collectionTime;
   patch.raw = {
     booking_id: bookingId,
     collection_slot:
       snapshot.collection_slot && typeof snapshot.collection_slot === "object"
         ? snapshot.collection_slot
         : null,
     slot_time:
       snapshot.slot_time && typeof snapshot.slot_time === "object"
         ? snapshot.slot_time
         : null,
     collection_time:
       snapshot.collection_time && typeof snapshot.collection_time === "object"
         ? snapshot.collection_time
         : null,
   };
 }
 if (snapshot.additional_members || snapshot.additional_member) {
   const existing = normalizeAdditionalMembers(
     snapshot.additional_members || snapshot.additional_member
   );
   patch.patients = existing;
 }

 return patch;
}

async function upsertBookingSnapshot(payload, source, extras = {}) {
 const patch = buildBookingPatchFromPayload(payload, source);
 if (!patch?.bookingId) return null;

 if (extras.lastWebhookType) {
   patch.lastWebhookType = extras.lastWebhookType;
 }
 if (extras.lastWebhookAt) {
   patch.lastWebhookAt = extras.lastWebhookAt;
 }

 const existing = await RedcliffeBooking.findOne(
   { bookingId: patch.bookingId },
   { bookingStatus: 1 }
 ).lean();
 const mergedPatch = mergeBookingStatusWithExisting(patch, existing);

 return RedcliffeBooking.findOneAndUpdate(
   { bookingId: patch.bookingId },
   { $set: mergedPatch },
   { new: true, upsert: true, setDefaultsOnInsert: true }
 );
}

async function syncCollectionDateIntoMongo(collectionDate) {
 const date = String(collectionDate || "").trim();
 if (!date) return { collectionDate: "", fetched: 0, upserted: 0 };

 const result = await proxyWithMockFallback({
   method: "GET",
   path: withQuery("/api/external/v2/center-get-booking/", {
     collection_date: date,
   }),
   query: {
     collection_date: date,
   },
 });

 if (result.status >= 400) {
   throw new Error(
     result.data?.message ||
       result.data?.detail ||
       `Failed to sync Redcliffe bookings for ${date}`
   );
 }

 const upstreamRecords = Array.isArray(result.data)
   ? result.data
   : toArray(result.data?.data);
 const normalized = upstreamRecords
   .map(normalizeBookingRecord)
   .filter((item) => String(item?.bookingId || "").trim());

 if (!normalized.length) {
   return { collectionDate: date, fetched: 0, upserted: 0 };
 }

 const bookingIds = normalized.map((item) => String(item.bookingId).trim());
 const existingRecords = await RedcliffeBooking.find(
   { bookingId: { $in: bookingIds } },
   { bookingId: 1, bookingStatus: 1 }
 ).lean();
 const existingByBookingId = new Map(
   existingRecords.map((item) => [String(item.bookingId).trim(), item])
 );
 const mergedNormalized = normalized.map((item) =>
   mergeBookingStatusWithExisting(
     item,
     existingByBookingId.get(String(item.bookingId).trim())
   )
 );

 await RedcliffeBooking.bulkWrite(
   mergedNormalized.map((item) => ({
     updateOne: {
       filter: { bookingId: String(item.bookingId).trim() },
       update: {
         $set: {
           ...item,
           bookingId: String(item.bookingId).trim(),
           lastSource: "sync-recent",
           lastSyncedAt: new Date(),
         },
       },
       upsert: true,
     },
   })),
   { ordered: false }
 );

 return {
   collectionDate: date,
   fetched: upstreamRecords.length,
   upserted: mergedNormalized.length,
 };
}

async function ensureRecentBookingsSynced({ force = false, days = RECENT_BOOKING_SYNC_DAYS } = {}) {
 const now = Date.now();
 if (!force && recentBookingSyncState.lastSuccessAt && now - recentBookingSyncState.lastSuccessAt < RECENT_BOOKING_SYNC_TTL_MS) {
   return { results: [], failures: [] };
 }
 if (recentBookingSyncState.inFlight) {
   return recentBookingSyncState.inFlight;
 }

 recentBookingSyncState.inFlight = (async () => {
   const dates = getRecentIsoDates(days);
   const results = [];
   const failures = [];
   for (const date of dates) {
     try {
       results.push(await syncCollectionDateIntoMongo(date));
     } catch (error) {
       console.error(
         `Redcliffe recent booking sync failed for ${date}:`,
         error?.message || error
       );
       failures.push({
         collectionDate: date,
         message: error?.message || `Failed to sync Redcliffe bookings for ${date}`,
       });
     }
   }

   if (!results.length && failures.length) {
     throw new Error(failures[0].message);
   }

   if (results.length) {
     recentBookingSyncState.lastSuccessAt = Date.now();
   }

   return { results, failures };
 })();

 try {
   return await recentBookingSyncState.inFlight;
 } finally {
   recentBookingSyncState.inFlight = null;
 }
}

async function fetchBookingDetailsDirect({ bookingId, phone, bookingDate, collectionDate }) {
 const trimmedBookingId = String(bookingId || "").trim();
 const phoneTail = getPhoneTail(phone);
 const attemptQueries = [];
 const pushAttempt = (query) => {
   const normalized = Object.entries(query)
     .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
     .sort(([a], [b]) => a.localeCompare(b));
   const signature = JSON.stringify(normalized);
   if (!signature || attemptQueries.some((item) => item.signature === signature)) return;
   attemptQueries.push({ query, signature });
 };

 pushAttempt({
   booking_id: trimmedBookingId,
   customer_phone: phoneTail,
   customer_phonenumber: phoneTail,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });
 pushAttempt({
   booking_id: trimmedBookingId,
   customer_phone: phoneTail,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });
 pushAttempt({
   booking_id: trimmedBookingId,
   customer_phonenumber: phoneTail,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });
 pushAttempt({
   booking_id: trimmedBookingId,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });
 pushAttempt({
   customer_phone: phoneTail,
   customer_phonenumber: phoneTail,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });
 pushAttempt({
   customer_phonenumber: phoneTail,
   booking_date: bookingDate,
   collection_date: collectionDate,
 });

 for (const attempt of attemptQueries) {
   const result = await proxyWithMockFallback({
     method: "GET",
     path: withQuery("/api/external/v2/center-get-booking/", attempt.query),
     query: attempt.query,
   });

   if (result.status >= 400) {
     if (![400, 404].includes(result.status)) {
       throw new Error(
         result.data?.message ||
           result.data?.detail ||
           "Failed to fetch booking details from Redcliffe."
       );
     }
     continue;
   }

   const upstreamRecords = Array.isArray(result.data)
     ? result.data
     : toArray(result.data?.data);
   const normalized = upstreamRecords
     .map(normalizeBookingRecord)
     .filter((item) => String(item?.bookingId || "").trim());

   const filtered = filterBookings(normalized, {
     booking_id: trimmedBookingId,
     phone: phoneTail,
   });

   const matched = filtered.length ? filtered : normalized;
   if (matched.length) {
     const bookingIds = matched.map((item) => String(item.bookingId).trim());
     const existingRecords = await RedcliffeBooking.find(
       { bookingId: { $in: bookingIds } },
       { bookingId: 1, bookingStatus: 1 }
     ).lean();
     const existingByBookingId = new Map(
       existingRecords.map((item) => [String(item.bookingId).trim(), item])
     );
     const mergedMatched = matched.map((item) =>
       mergeBookingStatusWithExisting(
         item,
         existingByBookingId.get(String(item.bookingId).trim())
       )
     );
     await RedcliffeBooking.bulkWrite(
       mergedMatched.map((item) => ({
         updateOne: {
           filter: { bookingId: String(item.bookingId).trim() },
           update: {
             $set: {
               ...item,
               bookingId: String(item.bookingId).trim(),
               lastSource: "direct-lookup",
               lastSyncedAt: new Date(),
             },
           },
           upsert: true,
         },
       })),
       { ordered: false }
     );
     return mergedMatched;
   }
 }

 return [];
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


function extractBookingIdFromPayload(payload) {
 if (!payload || typeof payload !== "object") return "";


 const candidateKeys = [
   "booking_id",
   "bookingId",
   "pk",
 ];


 for (const key of candidateKeys) {
   if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") {
     return String(payload[key]).trim();
   }
 }


 const nestedContainers = [
   payload.data,
   payload.details,
   payload.payload,
   payload.result,
 ];


 for (const container of nestedContainers) {
   if (container && typeof container === "object") {
     const nestedBookingId = extractBookingIdFromPayload(container);
     if (nestedBookingId) return nestedBookingId;
   }
 }


 return "";
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
   order_id: body.order_id || body.orderId || body.shopify_order_id || "",
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

function getRazorpayClient() {
 const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
 const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
 if (!keyId || !keySecret) {
   throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");
 }
 return new Razorpay({
   key_id: keyId,
   key_secret: keySecret,
 });
}

function getShopifyAdminConfig() {
 const shop = String(process.env.SHOPIFY_STORE_NAME || "").trim();
 const token = String(
   process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_ACCESS_TOKEN || ""
 ).trim();
 if (!shop || !token) {
   throw new Error("SHOPIFY_STORE_NAME and Shopify access token are required");
 }
 return {
   shop,
   token,
   baseUrl: `https://${shop}.myshopify.com/admin/api/2024-04`,
 };
}

function toAmount(value) {
 const amount = Number(value);
 return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function splitCustomerName(fullName) {
 const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
 return {
   firstName: parts[0] || "Customer",
   lastName: parts.slice(1).join(" ") || "-",
 };
}

function normalizeShopifyOrderPayload(input = {}) {
 const cartItems = Array.isArray(input.cartItems) ? input.cartItems : [];
 return {
   cartItems: cartItems
     .map((item) => ({
       variantId: String(item.variantId || item.variant_id || "").trim(),
       quantity: Math.max(1, Number(item.quantity || 1)),
     }))
     .filter((item) => item.variantId),
   shippingAddress: input.shippingAddress || {},
   billingAddress: input.billingAddress || input.shippingAddress || {},
   note: String(input.note || "").trim(),
 };
}

function buildAddressPayload(address = {}) {
 return {
   first_name: address.firstName || address.first_name || "",
   last_name: address.lastName || address.last_name || "",
   address1: address.address1 || "",
   address2: address.address2 || "",
   city: address.city || "",
   province: address.province || "",
   country: address.country || "India",
   zip: address.zip || "",
   phone: address.phone || "",
 };
}

function getPaymentLinkEntity(payload = {}) {
 return (
   payload?.payload?.payment_link?.entity ||
   payload?.payment_link?.entity ||
   payload?.payment_link ||
   payload
 );
}

function getPaymentEntity(payload = {}) {
 return (
   payload?.payload?.payment?.entity ||
   payload?.payment?.entity ||
   payload?.payment ||
   {}
 );
}

async function createPaidShopifyDraftOrder({ intent, paymentId }) {
 const { shop, token, baseUrl } = getShopifyAdminConfig();
 const shopifyPayload = normalizeShopifyOrderPayload(intent.shopifyOrderPayload);
 if (!shopifyPayload.cartItems.length) {
   throw new Error("Shopify cartItems are required to create draft order");
 }

 const bookingPayload = intent.bookingPayload || {};
 const customerName = splitCustomerName(bookingPayload.customer_name);
 const email = String(bookingPayload.customer_email || "").trim();
 const phone = String(bookingPayload.customer_phonenumber || "").trim();

 const draftPayload = {
   draft_order: {
     line_items: shopifyPayload.cartItems.map((item) => ({
       variant_id: item.variantId,
       quantity: item.quantity,
       properties: [
         { name: "redcliffe_booking_id", value: String(intent.bookingId || "") },
         { name: "redcliffe_payment_intent_id", value: String(intent.intentId || "") },
       ],
     })),
     email,
     shipping_address: buildAddressPayload({
       firstName: shopifyPayload.shippingAddress.firstName || customerName.firstName,
       lastName: shopifyPayload.shippingAddress.lastName || customerName.lastName,
       phone,
       ...shopifyPayload.shippingAddress,
     }),
     billing_address: buildAddressPayload({
       firstName: shopifyPayload.billingAddress.firstName || customerName.firstName,
       lastName: shopifyPayload.billingAddress.lastName || customerName.lastName,
       phone,
       ...shopifyPayload.billingAddress,
     }),
     note: [
       shopifyPayload.note,
       `Redcliffe booking: ${intent.bookingId}`,
       `Razorpay payment: ${paymentId || ""}`,
     ].filter(Boolean).join(" | "),
     note_attributes: [
       { name: "redcliffe_booking_id", value: String(intent.bookingId || "") },
       { name: "redcliffe_payment_intent_id", value: String(intent.intentId || "") },
       { name: "razorpay_payment_id", value: String(paymentId || "") },
     ],
     tags: "REDCLIFFE,PREPAID,RAZORPAY",
   },
 };

 const createRes = await fetch(`${baseUrl}/draft_orders.json`, {
   method: "POST",
   headers: {
     "X-Shopify-Access-Token": token,
     "Content-Type": "application/json",
     Accept: "application/json",
   },
   body: JSON.stringify(draftPayload),
 });
 const createData = await createRes.json();
 if (!createRes.ok) {
   throw new Error(
     createData?.errors
       ? JSON.stringify(createData.errors)
       : "Failed to create Shopify draft order"
   );
 }

 const draftOrder = createData.draft_order;
 const completeRes = await fetch(`${baseUrl}/draft_orders/${draftOrder.id}/complete.json`, {
   method: "PUT",
   headers: {
     "X-Shopify-Access-Token": token,
     "Content-Type": "application/json",
     Accept: "application/json",
   },
   body: JSON.stringify({ payment_pending: false }),
 });
 const completeData = await completeRes.json();
 if (!completeRes.ok) {
   throw new Error(
     completeData?.errors
       ? JSON.stringify(completeData.errors)
       : "Failed to complete Shopify draft order"
   );
 }

 return {
   shop,
   draftOrder,
   order: completeData.draft_order?.order || completeData.order || completeData.draft_order || null,
   raw: completeData,
 };
}

async function createRedcliffeBookingAfterPayment(intent) {
 if (intent?.bookingId) {
   return {
     bookingId: String(intent.bookingId || "").trim(),
     response: intent.bookingResponse || null,
   };
 }

 const bookingPayload = normalizeCreateBookingPayload(intent.bookingPayload || {});
 const { order_id: _ignoredOrderId, ...upstreamPayload } = bookingPayload;
 const result = await proxyWithMockFallback({
   method: "POST",
   path: "/api/external/v2/center-create-booking/",
   data: upstreamPayload,
 });

 if (result.status >= 400) {
   throw new Error(
     result.data?.message ||
       result.data?.detail ||
       "Failed to create Redcliffe booking after payment"
   );
 }

 await upsertBookingSnapshot(result.data, "razorpay-paid-create");

 const bookingId = String(
   result.data?.booking_id || result.data?.pk || ""
 ).trim();
 if (!bookingId) {
   throw new Error("Redcliffe booking was created after payment but booking id is missing");
 }

 return {
   bookingId,
   response: result.data,
 };
}

async function confirmPaidRedcliffeBooking(intent) {
 if (intent.redcliffeConfirmedAt) {
   return {
     alreadyConfirmed: true,
     bookingId: String(intent.bookingId || "").trim(),
     bookingResponse: intent.bookingResponse || null,
     response: intent.redcliffeConfirmResponse || null,
   };
 }

 const createdBooking = await createRedcliffeBookingAfterPayment(intent);
 const payload = {
   booking_id: createdBooking.bookingId,
   is_confirmed: true,
 };
 const result = await proxyWithMockFallback({
   method: "POST",
   path: "/api/external/v2/center-confirm-booking/",
   data: payload,
 });

 if (result.status >= 400) {
   throw new Error(
     result.data?.message ||
       result.data?.detail ||
       "Failed to confirm Redcliffe booking after payment"
   );
 }

 await upsertBookingSnapshot(
   { ...result.data, booking_id: createdBooking.bookingId },
   "razorpay-paid-confirm"
 );

 return {
   alreadyConfirmed: false,
   bookingId: createdBooking.bookingId,
   bookingResponse: createdBooking.response,
   response: result.data,
 };
}

async function finalizePaidRedcliffePaymentIntent(intent, webhookPayload) {
 if (!intent || intent.shopifyOrderId) {
   return intent;
 }

 const payment = getPaymentEntity(webhookPayload);
 const paymentId = String(payment?.id || intent.razorpayPaymentId || "").trim();
 const confirmation = await confirmPaidRedcliffeBooking(intent);
 const confirmedIntent = await RedcliffePaymentIntent.findOneAndUpdate(
   { intentId: intent.intentId },
   {
     $set: {
       status: "finalizing_shopify_order",
       bookingId: confirmation.bookingId,
       bookingResponse: confirmation.bookingResponse,
       razorpayPaymentId: paymentId,
       razorpayPayload: webhookPayload,
       redcliffeConfirmResponse: confirmation.response,
       redcliffeConfirmedAt: intent.redcliffeConfirmedAt || new Date(),
       paidAt: intent.paidAt || new Date(),
       errorMessage: "",
     },
   },
   { new: true }
 ).lean();

 const shopifyResult = await createPaidShopifyDraftOrder({
   intent: confirmedIntent || intent,
   paymentId,
 });
 const orderId = String(
   shopifyResult.order?.id ||
     shopifyResult.raw?.draft_order?.order_id ||
     shopifyResult.draftOrder?.order_id ||
     ""
 ).trim();
 const orderName = String(
   shopifyResult.order?.name ||
     shopifyResult.raw?.draft_order?.name ||
     ""
 ).trim();

 return RedcliffePaymentIntent.findOneAndUpdate(
   { intentId: intent.intentId },
   {
     $set: {
       status: "shopify_order_created",
       razorpayPaymentId: paymentId,
       razorpayPayload: webhookPayload,
       redcliffeConfirmResponse: confirmation.response,
       redcliffeConfirmedAt: confirmedIntent?.redcliffeConfirmedAt || new Date(),
       shopifyDraftOrderId: String(shopifyResult.draftOrder?.id || ""),
       shopifyOrderId: orderId,
       shopifyOrderName: orderName,
       shopifyFinalPayload: shopifyResult.raw,
       paidAt: intent.paidAt || new Date(),
       finalizedAt: new Date(),
       errorMessage: "",
     },
   },
   { new: true }
 );
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
 try {
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


   // Keep order_id for local context, but do not forward it to upstream create API.
   const { order_id: _ignoredOrderId, ...upstreamPayload } = payload;


   const result = await proxyWithMockFallback({
     method: "POST",
     path: "/api/external/v2/center-create-booking/",
     data: upstreamPayload,
   });

   if (result.status < 400) {
     await upsertBookingSnapshot(result.data, "create");
   }


   return res.status(result.status).json(result.data);
 } catch (error) {
   console.error("Redcliffe create booking route error:", error);
   return res.status(500).json({
     status: "failure",
     message: "Internal server error while creating booking",
     detail: error?.message || "Unknown server error",
   });
 }
});

router.post("/payments/razorpay/create-link", async (req, res) => {
 try {
   const amount = toAmount(req.body?.amount);
   if (!amount) {
     return res.status(400).json({
       status: "failure",
       message: "amount is required and must be greater than 0",
     });
   }

   const shopifyOrderPayload = normalizeShopifyOrderPayload(
     req.body?.shopifyOrderPayload || {}
   );
   if (!shopifyOrderPayload.cartItems.length) {
     return res.status(400).json({
       status: "failure",
       message: "shopifyOrderPayload.cartItems is required",
     });
   }

   const bookingPayload = normalizeCreateBookingPayload(req.body?.bookingPayload || {});
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
     const value = bookingPayload[field];
     return value === undefined || value === null || value === "";
   });
   if (missingField) {
     return res.status(400).json({
       status: "failure",
       message: `${missingField} is required`,
     });
   }
   if (!bookingPayload.package_code.length) {
     return res.status(400).json({
       status: "failure",
       message: "At least one package code is required",
     });
   }

   const intentId = crypto.randomUUID();
   const currency = String(req.body?.currency || "INR").trim() || "INR";
   const returnUrl = String(
     req.body?.return_url ||
       req.body?.returnUrl ||
       process.env.REDCLIFFE_RAZORPAY_RETURN_URL ||
       ""
   ).trim();

   const razorpay = getRazorpayClient();
   const paymentLinkPayload = {
     amount: Math.round(amount * 100),
     currency,
     accept_partial: false,
     description: `Redcliffe blood test booking payment ${intentId}`,
     reference_id: intentId,
     customer: {
       name: bookingPayload.customer_name,
       email: bookingPayload.customer_email,
       contact: bookingPayload.customer_phonenumber,
     },
     notify: {
       sms: true,
       email: true,
     },
     notes: {
       redcliffe_payment_intent_id: intentId,
       source: "shopify-redcliffe-booking",
     },
   };

   if (returnUrl) {
     paymentLinkPayload.callback_url = returnUrl;
     paymentLinkPayload.callback_method = "get";
   }

   const paymentLink = await razorpay.paymentLink.create(paymentLinkPayload);

   await RedcliffePaymentIntent.create({
     intentId,
     status: "payment_link_created",
     bookingId: "",
     bookingPayload,
     bookingResponse: null,
     shopifyOrderPayload,
     amount,
     currency,
     razorpayPaymentLinkId: String(paymentLink.id || ""),
     razorpayPaymentLinkUrl: String(paymentLink.short_url || ""),
   });

   return res.status(201).json({
     status: "success",
     intent_id: intentId,
     booking_id: "",
     payment_link_id: paymentLink.id,
     payment_link: paymentLink.short_url,
     booking_status: "pending_payment",
   });
 } catch (error) {
   console.error("Redcliffe Razorpay payment link error:", error?.response?.data || error);
   return res.status(500).json({
     status: "failure",
     message: "Failed to create Redcliffe Razorpay payment link",
     detail: error?.response?.data || error?.message || "Unknown server error",
   });
 }
});

router.get("/payments/razorpay/intents/:intentId", async (req, res) => {
 try {
   const intentId = String(req.params.intentId || "").trim();
   if (!intentId) {
     return res.status(400).json({
       status: "failure",
       message: "intentId is required",
     });
   }

   const intent = await RedcliffePaymentIntent.findOne({ intentId }).lean();
   if (!intent) {
     return res.status(404).json({
       status: "failure",
       message: "Redcliffe payment intent not found",
     });
   }

   return res.status(200).json({
     status: "success",
     intent: {
       intent_id: intent.intentId,
       status: intent.status,
       booking_id: intent.bookingId,
       amount: intent.amount,
       currency: intent.currency,
       payment_link: intent.razorpayPaymentLinkUrl,
       razorpay_payment_id: intent.razorpayPaymentId,
       redcliffe_confirmed: Boolean(intent.redcliffeConfirmedAt),
       shopify_order_id: intent.shopifyOrderId,
       shopify_order_name: intent.shopifyOrderName,
       paid_at: intent.paidAt,
       finalized_at: intent.finalizedAt,
       error_message: intent.errorMessage,
     },
   });
 } catch (error) {
   console.error("Redcliffe Razorpay intent status error:", error);
   return res.status(500).json({
     status: "failure",
     message: "Failed to fetch Redcliffe payment intent",
     detail: error?.message || "Unknown server error",
   });
 }
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
 if (result.status < 400) {
   await upsertBookingSnapshot(
     { ...result.data, booking_id },
     "confirm"
   );
 }
 return res.status(result.status).json(result.data);
});


router.post("/bookings/update", async (req, res) => {
 const {
   booking_id,
   booking_status,
   remark,
   collection_date,
   collection_slot,
 } = req.body || {};


 if (!booking_id && booking_id !== 0) {
   return res.status(400).json({
     status: "failure",
     message: "booking_id is required",
   });
 }


 const normalizedStatus = String(booking_status || "").trim().toLowerCase();
 if (!["rescheduled", "cancelled"].includes(normalizedStatus)) {
   return res.status(400).json({
     status: "failure",
     message: "booking_status must be either rescheduled or cancelled",
   });
 }


 if (!String(remark || "").trim()) {
   return res.status(400).json({
     status: "failure",
     message: "remark is required",
   });
 }


 if (normalizedStatus === "rescheduled") {
   if (!String(collection_date || "").trim()) {
     return res.status(400).json({
       status: "failure",
       message: "collection_date is required for rescheduled bookings",
     });
   }
   if (!Number.isFinite(Number(collection_slot)) || Number(collection_slot) <= 0) {
     return res.status(400).json({
       status: "failure",
       message: "a valid collection_slot is required for rescheduled bookings",
     });
   }
 }


 const payload = {
   booking_id,
   booking_status: normalizedStatus,
   remark: String(remark).trim(),
 };


 if (normalizedStatus === "rescheduled") {
   payload.collection_date = String(collection_date).trim();
   payload.collection_slot = Number(collection_slot);
 }


 const result = await proxyWithMockFallback({
   method: "POST",
   path: "/api/external/v2/center-update-booking/",
   data: payload,
 });

 if (result.status < 400) {
   await upsertBookingSnapshot(
     {
       ...result.data,
       booking_id,
       booking_status: normalizedStatus,
       collection_date: payload.collection_date,
       collection_slot: payload.collection_slot,
     },
     "update"
   );
 }


 return res.status(result.status).json(result.data);
});


router.post("/bookings/:bookingId/add-member", async (req, res) => {
 const bookingId = String(req.params.bookingId || "").trim();
 const members = toArray(req.body?.additional_member);


 if (!bookingId) {
   return res.status(400).json({
     status: "failure",
     message: "bookingId is required",
   });
 }


 if (!members.length) {
   return res.status(400).json({
     status: "failure",
     message: "additional_member is required",
   });
 }


 const normalizedMembers = members.map((member) => ({
   customer_name: String(member?.customer_name || member?.customerName || "").trim(),
   customer_age: member?.customer_age ?? member?.customerAge ?? "",
   customer_gender: String(member?.customer_gender || member?.customerGender || "").trim(),
   package_code: parsePackageCodes(member?.package_code || member?.packageCode),
 }));


 const hasInvalidMember = normalizedMembers.some(
   (member) =>
     !member.customer_name ||
     member.customer_age === "" ||
     !member.customer_gender ||
     !member.package_code.length
 );


 if (hasInvalidMember) {
   return res.status(400).json({
     status: "failure",
     message:
       "Each additional member must include customer_name, customer_age, customer_gender and package_code",
   });
 }


 const payloadVariants = [
   {
     additional_member: normalizedMembers,
   },
   {
     additional_members: normalizedMembers,
   },
   {
     additional_member: normalizedMembers.map((member) => ({
       customerName: member.customer_name,
       customerAge: member.customer_age,
       customerGender: member.customer_gender,
       packageCode: member.package_code,
     })),
   },
 ];


 const endpointCandidates = [
   {
     method: "POST",
     path: `/api/external/v2/open-add-member/${encodeURIComponent(bookingId)}`,
   },
   {
     method: "POST",
     path: `/api/external/v2/open-add-member/${encodeURIComponent(bookingId)}/`,
   },
   {
     method: "PUT",
     path: `/api/external/v2/open-add-member/${encodeURIComponent(bookingId)}`,
   },
   {
     method: "PUT",
     path: `/api/external/v2/open-add-member/${encodeURIComponent(bookingId)}/`,
   },
 ];


 let finalResult = null;
 const attempts = [];


 for (const payload of payloadVariants) {
   for (const candidate of endpointCandidates) {
     const attempt = await proxyWithMockFallback({
       method: candidate.method,
       path: candidate.path,
       data: payload,
     });


     attempts.push({
       method: candidate.method,
       path: candidate.path,
       status: attempt?.status,
       message:
         attempt?.data?.message ||
         attempt?.data?.detail ||
         "",
     });


     if (attempt.status < 400) {
       finalResult = attempt;
       break;
     }


     finalResult = attempt;
     if (![400, 404, 405].includes(attempt.status)) {
       break;
     }
   }


   if (finalResult && finalResult.status < 400) break;
 }


 if (finalResult && finalResult.status < 400) {
   await upsertBookingSnapshot(
     {
       ...finalResult.data,
       booking_id: bookingId,
     },
     "add-member"
   );
   return res.status(finalResult.status).json(finalResult.data);
 }


 return res.status(finalResult?.status || 500).json({
   status: "failure",
   message:
     finalResult?.data?.message ||
     finalResult?.data?.detail ||
     "Unable to add additional member.",
   detail: "All supported add-member endpoint/payload combinations failed.",
   attempts,
 });
});


router.get("/bookings", async (req, res) => {
 try {
   const todayIso = toIsoDate();
   const recentDates = getRecentIsoDates();
   const oldestRecentIso = recentDates[0];
   const requestedCollectionDate = String(req.query.collection_date || "").trim();
   const phone = String(req.query.phone || req.query.customer_phone || "").trim();
   const clientRef = String(req.query.client_ref_id || req.query.reference_data || "").trim();
   const packageCode = String(req.query.package_code || "").trim();
   const bookingId = String(req.query.booking_id || "").trim();
   const bookingStatus = String(req.query.booking_status || "").trim();
   const bookingDate = String(req.query.booking_date || "").trim();
   const hasExplicitLookup = Boolean(
     bookingId || bookingStatus || bookingDate || requestedCollectionDate || phone || clientRef || packageCode
   );
   let syncSummary = { results: [], failures: [] };

   if (!hasExplicitLookup) {
     syncSummary = await ensureRecentBookingsSynced();
   }

   const query = {};

   if (bookingId) query.bookingId = bookingId;
   if (bookingStatus) query["bookingStatus.value"] = bookingStatus;
   if (bookingDate) query.bookingDate = bookingDate;
   if (requestedCollectionDate) {
     query.collectionDate = requestedCollectionDate;
   } else if (!hasExplicitLookup) {
     query.collectionDate = { $gte: oldestRecentIso, $lte: todayIso };
   }

   const records = await RedcliffeBooking.find(query)
     .sort({ collectionDate: -1, updatedAt: -1 })
     .lean();

   let filtered = filterBookings(records, req.query || {});
   let directLookupUsed = false;

   if (!filtered.length && hasExplicitLookup && (bookingId || phone)) {
     const directMatches = await fetchBookingDetailsDirect({
       bookingId,
       phone,
       bookingDate,
       collectionDate: requestedCollectionDate,
     });
     if (directMatches.length) {
       filtered = directMatches;
       directLookupUsed = true;
     }
   }

   return res.status(200).json({
     status: "success",
     message: directLookupUsed
       ? "Booking details fetched directly from Redcliffe."
       : "Booking details fetched successfully",
     count: filtered.length,
     directLookupUsed,
     sync: !hasExplicitLookup
       ? {
           attempted: recentDates.length,
           succeeded: syncSummary.results.length,
           failed: syncSummary.failures.length,
           failures: syncSummary.failures,
         }
       : undefined,
     summary: {
       total: filtered.length,
       bookingStatus: buildStatusSummary(
         filtered,
         (item) => item.bookingStatus.value || "unknown"
       ),
       pickupStatus: buildStatusSummary(
         filtered,
         (item) => item.pickupStatus || "unknown"
       ),
       reportStatus: buildStatusSummary(
         filtered,
         (item) => item.reportStatus || "none"
       ),
     },
     results: filtered,
   });
 } catch (error) {
   console.error("Redcliffe bookings route error:", error);
   return res.status(500).json({
     status: "failure",
     message: "Failed to load booking details.",
     detail: error?.message || "Unknown server error",
   });
 }
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


router.get("/bookings/lifecycle", async (req, res) => {
 const bookingIds = String(req.query.booking_ids || "")
   .split(",")
   .map((id) => String(id || "").trim())
   .filter(Boolean);


 if (!bookingIds.length) {
   return res.status(400).json({
     status: "failure",
     message: "booking_ids is required",
   });
 }


 const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
 const logs = await RedcliffeWebhookEvent.find({})
   .sort({ createdAt: -1 })
   .limit(limit)
   .lean();


 const grouped = {};
 bookingIds.forEach((id) => {
   grouped[id] = [];
 });


 logs.forEach((log) => {
   const bookingId = extractBookingIdFromPayload(log.payload);
   if (!bookingId || !grouped[bookingId]) return;
   grouped[bookingId].push({
     hookType: String(log.hookType || "").trim(),
     createdAt: log.createdAt,
     deliveryStatus: log.deliveryStatus,
     authVerified: Boolean(log.authVerified),
   });
 });


 return res.status(200).json({
   status: "success",
   results: grouped,
 });
});


router.get("/bookings/:bookingId/reports/consolidated", async (req, res) => {
 const bookingId = String(req.params.bookingId || "").trim();


 if (!bookingId) {
   return res.status(400).json({
     status: "failure",
     message: "bookingId is required",
   });
 }


 const result = await proxyWithMockFallback({
   method: "GET",
   path: `/api/external/v2/get-consolidated-report/${encodeURIComponent(bookingId)}`,
 });


 if (result.status >= 400) {
   return res.status(result.status).json(result.data);
 }

 return res.status(200).json({
   ...result.data,
   report_url: extractReportUrl(result.data),
 });
});


router.get("/bookings/:bookingId/reports/digital", async (req, res) => {
 const bookingId = String(req.params.bookingId || "").trim();


 if (!bookingId) {
   return res.status(400).json({
     status: "failure",
     message: "bookingId is required",
   });
 }


 const result = await proxyWithMockFallback({
   method: "GET",
   path: `/api/external/v2/get-digital-report/${encodeURIComponent(bookingId)}`,
 });


 if (result.status >= 400) {
   return res.status(result.status).json(result.data);
 }

 return res.status(200).json({
   ...result.data,
   report_url: extractReportUrl(result.data),
 });
});


router.get("/packages", async (_req, res) => {
 const result = await proxyWithMockFallback({
   method: "GET",
   path: "/api/external/v2/center-package-data/",
 });


 if (result.status >= 400) {
   return res.status(result.status).json({
     ...result.data,
     message:
       result.data?.message ||
       result.data?.detail ||
       "Unable to fetch Redcliffe package catalog.",
   });
 }


 const items = Array.isArray(result.data?.data)
   ? result.data.data
   : Array.isArray(result.data?.results)
     ? result.data.results
     : [];


 const normalized = items
   .map((item) => ({
     id: item?.id ?? null,
     code: String(item?.code || "").trim(),
     name: String(item?.name || item?.test_name || item?.package_name || "").trim(),
     description: String(item?.description || "").trim(),
     type: String(item?.type || "").trim(),
     price:
       item?.package_center_prices?.offer_price ??
       item?.package_center_prices?.package_price ??
       item?.offer_price ??
       item?.package_price ??
       null,
   }))
   .filter((item) => item.code && item.name);


 return res.status(200).json({
   status: result.data?.status || "success",
   message: result.data?.message || "Package catalog fetched successfully",
   count: normalized.length,
   results: normalized,
   raw: result.data,
 });
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

 await upsertBookingSnapshot(
   getWebhookBookingPayload(payload),
   "webhook",
   {
     lastWebhookType: hookType,
     lastWebhookAt: new Date(),
   }
 );


 return res.status(200).json({
   status: "success",
   message: "Webhook received",
   hookType,
 });
});

webhookRouter.post(
 "/payments/razorpay/webhook",
 express.raw({ type: "application/json", limit: "2mb" }),
 async (req, res) => {
   try {
     const rawBody = Buffer.isBuffer(req.body)
       ? req.body
       : Buffer.from(req.body || "");
     const signature = String(req.get("X-Razorpay-Signature") || "").trim();
     const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

     if (secret) {
       const digest = crypto
         .createHmac("sha256", secret)
         .update(rawBody)
         .digest("hex");
       if (!signature || digest !== signature) {
         return res.status(401).send("Invalid Razorpay webhook signature");
       }
     }

     let payload = {};
     try {
       payload = JSON.parse(rawBody.toString("utf8") || "{}");
     } catch (_error) {
       return res.status(400).send("Invalid Razorpay webhook payload");
     }

     const event = String(payload.event || "").trim();
     const paymentLink = getPaymentLinkEntity(payload);
     const payment = getPaymentEntity(payload);
     const linkStatus = String(paymentLink?.status || "").trim().toLowerCase();
     if (event && !["payment_link.paid", "payment.captured"].includes(event)) {
       return res.status(200).json({ status: "ignored", event });
     }
     if (paymentLink?.status && linkStatus !== "paid") {
       return res.status(200).json({ status: "ignored", payment_link_status: linkStatus });
     }

     const intentId = String(
       paymentLink?.reference_id ||
         payment?.notes?.redcliffe_payment_intent_id ||
         ""
     ).trim();
     const paymentLinkId = String(
       paymentLink?.id || payment?.notes?.razorpay_payment_link_id || ""
     ).trim();
     if (!intentId && !paymentLinkId) {
       return res.status(200).json({
         status: "ignored",
         reason: "No Redcliffe payment intent reference found",
       });
     }
     const query = intentId
       ? { intentId }
       : { razorpayPaymentLinkId: paymentLinkId };
     const intent = await RedcliffePaymentIntent.findOne(query).lean();
     if (!intent) {
       return res.status(404).json({
         status: "failure",
         message: "Redcliffe payment intent not found",
       });
     }

     const existingFinalizedIntent = await RedcliffePaymentIntent.findOne({
       intentId: intent.intentId,
       shopifyOrderId: { $ne: "" },
     }).lean();
     if (existingFinalizedIntent) {
       return res.status(200).json({
         status: "success",
         intent_id: existingFinalizedIntent.intentId,
         shopify_order_id: existingFinalizedIntent.shopifyOrderId,
         shopify_order_name: existingFinalizedIntent.shopifyOrderName,
         duplicate_event: true,
       });
     }

     const paidIntent = await RedcliffePaymentIntent.findOneAndUpdate(
       {
         intentId: intent.intentId,
         shopifyOrderId: "",
         status: {
           $nin: [
             "redcliffe_booking_confirmed",
             "finalizing_shopify_order",
             "shopify_order_created",
           ],
         },
       },
       {
         $set: {
           status: "finalizing_shopify_order",
           razorpayPayload: payload,
           paidAt: new Date(),
           errorMessage: "",
         },
       },
       { new: true }
     ).lean();
     if (!paidIntent) {
       const currentIntent = await RedcliffePaymentIntent.findOne({
         intentId: intent.intentId,
       }).lean();
       return res.status(200).json({
         status: "processing",
         intent_id: currentIntent?.intentId || intent.intentId,
         shopify_order_id: currentIntent?.shopifyOrderId || "",
         shopify_order_name: currentIntent?.shopifyOrderName || "",
         duplicate_event: true,
       });
     }

     const finalized = await finalizePaidRedcliffePaymentIntent(paidIntent, payload);
     return res.status(200).json({
       status: "success",
       intent_id: finalized.intentId,
       shopify_order_id: finalized.shopifyOrderId,
       shopify_order_name: finalized.shopifyOrderName,
     });
   } catch (error) {
     console.error("Redcliffe Razorpay webhook error:", error);
     const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
     let parsed = {};
     try {
       parsed = JSON.parse(body.toString("utf8") || "{}");
     } catch (_error) {}
     const paymentLink = getPaymentLinkEntity(parsed);
     const payment = getPaymentEntity(parsed);
     const intentId = String(
       paymentLink?.reference_id ||
         payment?.notes?.redcliffe_payment_intent_id ||
         ""
     ).trim();
     if (intentId) {
       await RedcliffePaymentIntent.updateOne(
         { intentId },
         {
           $set: {
             status: "failed",
             errorMessage: error?.message || "Failed to finalize paid Redcliffe order",
             razorpayPayload: parsed,
           },
         }
       );
     }
     return res.status(500).json({
       status: "failure",
       message: "Failed to process Redcliffe Razorpay webhook",
       detail: error?.message || "Unknown server error",
     });
   }
 }
);

router.webhookRouter = webhookRouter;

module.exports = router;
