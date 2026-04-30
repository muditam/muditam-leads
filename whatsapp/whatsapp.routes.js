const express = require("express");
const axios = require("axios");
const AWS = require("aws-sdk");
const multer = require("multer");
const FormData = require("form-data");
const path = require("path");
const mongoose = require("mongoose");
const OpenAI = require("openai");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");
const WhatsAppAutoReplySettings = require("../models/WhatsAppAutoReplySettings");

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");

const router = express.Router();

const WhatsAppWebhookDebug =
  mongoose.models.WhatsAppWebhookDebug ||
  mongoose.model(
    "WhatsAppWebhookDebug",
    new mongoose.Schema(
      {
        webhookType: String,
        outcome: String,
        status: String,
        waId: String,
        transactionId: String,
        phone: String,
        matchedMessageId: String,
        matchedStatus: String,
        raw: Object,
        receivedAt: { type: Date, default: Date.now, index: true },
      },
      { minimize: false }
    )
  );

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const DEFAULT_AUTO_REPLY_ENABLED =
  String(process.env.WHATSAPP_AUTO_REPLY_ENABLED ?? "true").toLowerCase() !==
  "false";
const DEFAULT_AUTO_REPLY_DELAY_MINUTES = Math.max(
  1,
  Number(process.env.WHATSAPP_AUTO_REPLY_DELAY_MINUTES || 15)
);
const DEFAULT_AUTO_REPLY_AI_SIGNATURE = String(
  process.env.WHATSAPP_AUTO_REPLY_AI_SIGNATURE || "~ AI ✨"
).trim();
const AUTO_REPLY_SCAN_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.WHATSAPP_AUTO_REPLY_SCAN_INTERVAL_MS || 60000)
);
const AUTO_REPLY_TEXT = String(
  process.env.WHATSAPP_AUTO_REPLY_TEXT ||
    "Thanks for waiting. I'm checking this for you and will get back shortly."
).trim();
const AUTO_REPLY_AI_ENABLED =
  String(process.env.WHATSAPP_AUTO_REPLY_AI_ENABLED ?? "true").toLowerCase() !==
  "false";
const AUTO_REPLY_AI_MAX_OUTPUT_TOKENS = Math.max(
  80,
  Number(process.env.WHATSAPP_AUTO_REPLY_AI_MAX_OUTPUT_TOKENS || 220)
);
const AUTO_REPLY_AI_MAX_CONTEXT_MESSAGES = Math.max(
  4,
  Number(process.env.WHATSAPP_AUTO_REPLY_AI_MAX_CONTEXT_MESSAGES || 10)
);
const AUTO_REPLY_AI_MODEL = String(
  process.env.WHATSAPP_AUTO_REPLY_AI_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-5-mini"
).trim();
const openaiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const AUTO_REPLY_CAN_SEND = Boolean(
  AUTO_REPLY_TEXT || (AUTO_REPLY_AI_ENABLED && openai)
);
let autoReplyWatchdogRunning = false;

async function getAutoReplyRuntimeSettings() {
  try {
    const doc = await WhatsAppAutoReplySettings.findOne({
      singletonKey: "default",
    })
      .select("enabled delayMinutes aiSignature")
      .lean();
    return {
      enabled:
        typeof doc?.enabled === "boolean"
          ? doc.enabled
          : DEFAULT_AUTO_REPLY_ENABLED,
      delayMinutes: Math.max(
        1,
        Number(doc?.delayMinutes || DEFAULT_AUTO_REPLY_DELAY_MINUTES)
      ),
      aiSignature: safeStr(doc?.aiSignature || DEFAULT_AUTO_REPLY_AI_SIGNATURE),
    };
  } catch (e) {
    console.error("[WA auto-reply] settings read failed:", e?.message || e);
    return {
      enabled: DEFAULT_AUTO_REPLY_ENABLED,
      delayMinutes: DEFAULT_AUTO_REPLY_DELAY_MINUTES,
      aiSignature: DEFAULT_AUTO_REPLY_AI_SIGNATURE,
    };
  }
}

/* ----------------------------------------
   TRUSTSIGNAL CONFIG
----------------------------------------- */
const TRUSTSIGNAL_API_BASE = String(
  process.env.TRUSTSIGNAL_API_BASE || "https://wpapi.trustsignal.io"
).replace(/\/+$/, "");

const TRUSTSIGNAL_API_KEY = String(
  process.env.TRUSTSIGNAL_API_KEY || ""
).trim();

const TS_PATH_SEND_REPLY = "/api/v1/whatsapp/agent-reply";
const TS_PATH_SEND_TEMPLATE = "/api/v1/whatsapp/single";
const TS_PATH_UPLOAD_MEDIA = "/v1/whatsapp/media";

const trustsignalClient = axios.create({
  baseURL: TRUSTSIGNAL_API_BASE,
  timeout: 60000,
  validateStatus: () => true,
});

/* ----------------------------------------
   WASABI CONFIG
----------------------------------------- */
const WASABI_ENDPOINT = String(process.env.WASABI_ENDPOINT || "").replace(
  /\/+$/,
  ""
);
const WASABI_REGION = String(
  process.env.WASABI_REGION || "ap-southeast-2"
).trim();
const WASABI_BUCKET = String(process.env.WASABI_BUCKET || "").trim();

const WASABI_ACCESS_KEY = String(
  process.env.WASABI_ACCESS_KEY ||
  process.env.WASABI_ACCESS_KEY_ID ||
  ""
).trim();

const WASABI_SECRET_KEY = String(
  process.env.WASABI_SECRET_KEY ||
  process.env.WASABI_SECRET_ACCESS_KEY ||
  ""
).trim();

const s3 =
  WASABI_ENDPOINT &&
    WASABI_ACCESS_KEY &&
    WASABI_SECRET_KEY &&
    WASABI_BUCKET
    ? new AWS.S3({
      endpoint: new AWS.Endpoint(WASABI_ENDPOINT),
      region: WASABI_REGION,
      accessKeyId: WASABI_ACCESS_KEY,
      secretAccessKey: WASABI_SECRET_KEY,
      signatureVersion: "v4",
      s3ForcePathStyle: true,
    })
    : null;

/* ----------------------------------------
   GENERIC HELPERS
----------------------------------------- */
const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);
const normalizeText = (v = "") => String(v || "").trim().toLowerCase();

function normalizeWaId(v = "") {
  const d = digitsOnly(v);
  if (!d) return "";
  if (d.length === 10) return `91${d}`;
  return d;
}

function safeStr(v = "") {
  return String(v ?? "").trim();
}

function messageIdentityKeyForList(msg = {}) {
  const waId = String(msg?.waId || "").trim();
  if (waId) return `wa:${waId}`;
  const dbId = String(msg?._id || "").trim();
  if (dbId) return `id:${dbId}`;
  const dir = String(msg?.direction || "").toUpperCase();
  const from = last10(msg?.from || "");
  const to = last10(msg?.to || "");
  const type = String(msg?.type || "text").toLowerCase();
  const text = normalizeText(msg?.text || "");
  const mediaId = String(msg?.media?.id || "").trim();
  const mediaUrl = String(msg?.media?.url || "").trim();
  const ts = msg?.timestamp ? new Date(msg.timestamp).getTime() : 0;
  const tsBucket = ts ? Math.floor(ts / 1000) : "";
  return `sig:${dir}|${from}|${to}|${type}|${text}|${mediaId}|${mediaUrl}|${tsBucket}`;
}

function toE164Plus(v = "") {
  const d = digitsOnly(v);
  return d ? `+${d}` : "";
}

function getTrustSignalRecipient(v = "") {
  return normalizeWaId(v);
}

function normalizeTemplateName(v = "") {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 250);
}

function normalizeTemplateStatus(v = "") {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "UNKNOWN";
  if (s.includes("APPROV")) return "APPROVED";
  if (s.includes("REJECT")) return "REJECTED";
  if (s.includes("PEND")) return "PENDING";
  return s;
}

function normalizeTemplateCategory(v = "") {
  return String(v || "").trim().toUpperCase();
}

function normalizeTemplateHeaderFormat(v = "") {
  const f = String(v || "").trim().toUpperCase();
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(f)) return f;
  return "";
}

function isObjectLike(v) {
  return v !== null && typeof v === "object";
}

function compilePath(pathTemplate = "", pathParams = {}) {
  let out = String(pathTemplate || "");
  for (const [k, v] of Object.entries(pathParams || {})) {
    out = out.replace(
      new RegExp(`:${k}\\b`, "g"),
      encodeURIComponent(String(v ?? ""))
    );
  }
  return out;
}

function deepPick(obj, candidates = []) {
  if (!isObjectLike(obj) && !Array.isArray(obj)) return null;

  for (const key of candidates) {
    const parts = String(key).split(".");
    let cur = obj;
    let ok = true;

    for (const p of parts) {
      if (!isObjectLike(cur) && !Array.isArray(cur)) {
        ok = false;
        break;
      }
      if (!(p in cur)) {
        ok = false;
        break;
      }
      cur = cur[p];
    }

    if (ok && cur != null && cur !== "") return cur;
  }

  return null;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function okOrThrow(resp, fallbackMessage = "Provider request failed") {
  if (resp.status >= 200 && resp.status < 300) return resp;

  const message =
    deepPick(resp.data, [
      "message",
      "error.message",
      "error",
      "details",
      "result.message",
    ]) ||
    (typeof resp.data === "string" ? resp.data : "") ||
    `${fallbackMessage} (${resp.status})`;

  const err = new Error(String(message));
  err.status = resp.status;
  err.data = resp.data;
  throw err;
}

function isHtmlLikeResponse(data, headers = {}) {
  const ct = String(
    headers["content-type"] || headers["Content-Type"] || ""
  ).toLowerCase();

  if (ct.includes("text/html")) return true;

  if (typeof data === "string") {
    const s = data.trim().toLowerCase();
    if (s.startsWith("<!doctype html")) return true;
    if (s.startsWith("<html")) return true;
    if (s.includes("<title>404")) return true;
    if (s.includes("<body")) return true;
  }

  return false;
}

function buildHeaders(extra = {}) {
  const headers = {
    accept: "*/*",
    ...extra,
  };

  if (TRUSTSIGNAL_API_KEY) {
    headers["x-api-key"] = TRUSTSIGNAL_API_KEY;
    headers["api-key"] = TRUSTSIGNAL_API_KEY;
  }

  return headers;
}

function buildParams(extra = {}) {
  const params = { ...(extra || {}) };
  if (TRUSTSIGNAL_API_KEY) {
    params.api_key = TRUSTSIGNAL_API_KEY;
  }
  return params;
}

function findProviderError(data, matcher) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return errors.find((err) => matcher(err)) || null;
}

function extractProviderMessageId(data) {
  return (
    deepPick(data, [
      "message_id",
      "results.message_id",
      "results.0.message_id",
      "data.message_id",
      "data.results.message_id",
      "data.results.0.message_id",
      "msg_id",
      "data.msg_id",
      "id",
      "data.id",
      "message.id",
      "messages.0.id",
      "data.messages.0.id",
      "result.message_id",
      "result.id",
    ]) || null
  );
}

function extractProviderTransactionId(data) {
  return String(
    deepPick(data, [
      "transaction_id",
      "results.transaction_id",
      "results.0.transaction_id",
      "data.transaction_id",
      "data.results.transaction_id",
      "data.results.0.transaction_id",
      "result.transaction_id",
    ]) || ""
  ).trim();
}

function extractProviderAcceptId(data) {
  return (
    extractProviderMessageId(data) ||
    extractProviderTransactionId(data) ||
    null
  );
}

function ensureTrustSignalAccepted(
  data,
  fallbackMessage = "Provider rejected request"
) {
  const body = data || {};

  const explicitFalse =
    body?.success === false ||
    body?.status === false ||
    body?.ok === false ||
    body?.message_delivered === false;

  const providerErrors = Array.isArray(body?.errors) ? body.errors : [];
  const hasErrors = providerErrors.length > 0;
  const acceptId = extractProviderAcceptId(body);

  if (explicitFalse || hasErrors) {
    const err = new Error(
      providerErrors?.[0]?.message || body?.message || fallbackMessage
    );
    err.status = 400;
    err.data = body;
    throw err;
  }

  if (!acceptId) {
    const err = new Error(
      body?.message || "Provider did not return acceptance id"
    );
    err.status = 400;
    err.data = body;
    throw err;
  }

  return body;
}

function extractProviderMediaId(data) {
  return (
    deepPick(data, [
      "media_id",
      "data.media_id",
      "id",
      "data.id",
      "media.id",
      "result.media_id",
      "result.id",
      "upload.id",
    ]) || null
  );
}

function getTrustSignalSenderOrThrow() {
  const senderRaw = String(
    process.env.TRUSTSIGNAL_SENDER_ID ||
    process.env.TRUSTSIGNAL_SENDER ||
    process.env.WHATSAPP_BUSINESS_PHONE ||
    ""
  ).trim();

  const sender = digitsOnly(senderRaw) || senderRaw;
  if (!sender) {
    const err = new Error(
      "TrustSignal sender missing. Set TRUSTSIGNAL_SENDER_ID in env."
    );
    err.status = 500;
    throw err;
  }

  return sender;
}

function senderForDb(sender = "") {
  const raw = String(sender || "").trim();
  const d = digitsOnly(raw);
  return d ? normalizeWaId(d) : raw;
}

function templateComponents(tpl) {
  return Array.isArray(tpl?.components) ? tpl.components : [];
}

function extractTemplateBodyText(tpl) {
  if (!tpl) return "";
  if (typeof tpl?.body === "string" && tpl.body.trim()) return tpl.body;
  if (typeof tpl?.bodyText === "string" && tpl.bodyText.trim())
    return tpl.bodyText;
  if (typeof tpl?.text === "string" && tpl.text.trim()) return tpl.text;

  const comps = templateComponents(tpl);
  const bodyComp =
    comps.find((x) => String(x?.type || "").toUpperCase() === "BODY") ||
    comps.find((x) => String(x?.type || "").toLowerCase() === "body");

  if (typeof bodyComp?.text === "string") return bodyComp.text;
  return "";
}

function applyTemplateVars(bodyText, vars) {
  if (!bodyText) return "";
  return bodyText.replace(/{{\s*(\d+)\s*}}/g, (_, num) => {
    const i = parseInt(num, 10) - 1;
    const v = vars?.[i];
    return v != null && String(v).trim() !== "" ? String(v) : `{{${num}}}`;
  });
}

function resolveTemplateIdentifier(tpl, fallback = "") {
  return String(
    deepPick(tpl, [
      "template_id",
      "templateId",
      "providerTemplateId",
      "provider_template_id",
      "externalTemplateId",
      "raw360.id",
      "raw360.templateId",
      "raw360.template_id",
      "raw360.data.id",
      "raw360.template.id",
      "data.id",
      "template.id",
    ]) ||
    fallback ||
    ""
  ).trim();
}

function hasRealMedia(media = {}) {
  return Boolean(
    String(media?.id || "").trim() ||
    String(media?.url || "").trim() ||
    String(media?.mime || "").trim() ||
    String(media?.filename || "").trim()
  );
}

function sanitizeFilename(name = "") {
  return path
    .basename(String(name || "").trim() || "file")
    .replace(/[^\w.\-()]+/g, "_");
}

function buildWasabiPublicUrl(key = "") {
  const ep = String(WASABI_ENDPOINT || "").replace(/\/+$/, "");
  if (!ep || !WASABI_BUCKET || !key) return "";
  return `${ep}/${encodeURIComponent(WASABI_BUCKET)}/${String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function extFromMime(mime = "") {
  const m = String(mime || "").toLowerCase();

  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mov")) return "mov";
  if (m.includes("pdf")) return "pdf";

  if (
    m.includes("audio/ogg") ||
    m.includes("application/ogg") ||
    m.includes("ogg")
  ) {
    return "ogg";
  }
  if (m.includes("opus")) return "ogg";
  if (m.includes("audio/mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("m4a") || m.includes("mp4a") || m.includes("aac")) {
    return "m4a";
  }

  return "bin";
}

function inferMediaType({ type = "", mime = "", filename = "", url = "" }) {
  const rawType = String(type || "").toLowerCase().trim();
  const m = String(mime || "").toLowerCase();
  const f = String(filename || "").toLowerCase();
  const u = String(url || "").toLowerCase();

  if (rawType === "sticker") return "image";
  if (["image", "video", "audio", "document"].includes(rawType)) return rawType;

  if (
    m.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp|gif)$/i.test(f) ||
    /\.(png|jpg|jpeg|webp|gif)$/i.test(u)
  ) {
    return "image";
  }

  if (
    m.startsWith("video/") ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(f) ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(u)
  ) {
    return "video";
  }

  if (
    m.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|opus)$/i.test(f) ||
    /\.(mp3|wav|ogg|m4a|aac|opus)$/i.test(u)
  ) {
    return "audio";
  }

  if (rawType === "file" || rawType === "media" || m || f || u) {
    return "document";
  }

  return "text";
}

function normalizeOutgoingMediaType(type = "") {
  const t = String(type || "").toLowerCase().trim();
  if (t === "image" || t === "video" || t === "audio" || t === "document") {
    return t;
  }
  return "document";
}

function previewTextForType(type = "", filename = "") {
  if (type === "image") return "📷 Photo";
  if (type === "video") return "🎥 Video";
  if (type === "audio") return "🎙️ Audio";
  return filename ? `📎 ${filename}` : "📎 Attachment";
}

function templateMessageTypeFromHeaderFormat(
  headerFormat = "",
  hasVars = false
) {
  const fmt = normalizeTemplateHeaderFormat(headerFormat);
  if (fmt === "IMAGE" || fmt === "VIDEO") return "image_video";
  if (fmt === "DOCUMENT") return "document";
  return hasVars ? "text_var" : "text";
}

function templateSvalFromMessageType(messageType = "") {
  const t = String(messageType || "").toLowerCase().trim();
  if (t === "text") return 1;
  if (t === "text_var") return 2;
  if (t === "image_video") return 3;
  if (t === "document") return 4;
  if (t === "carousel") return 5;
  return undefined;
}

function normalizeTemplateHeaderMediaInput(headerMedia = null) {
  if (!isObjectLike(headerMedia)) return null;

  const format = normalizeTemplateHeaderFormat(headerMedia.format || "");
  const id = String(headerMedia.id || "").trim();
  const filename = sanitizeFilename(headerMedia.filename || "");
  const url = String(headerMedia.url || "").trim();
  const mime = String(headerMedia.mime || "").trim();

  if (!format && !id && !url && !filename && !mime) return null;

  return {
    format,
    id,
    filename,
    url,
    mime,
  };
}

function buildTrustSignalTemplatePayload({
  sender,
  to,
  providerTemplateId,
  parameters = [],
  headerMedia = null,
}) {
  const normalizedHeader = normalizeTemplateHeaderMediaInput(headerMedia);
  const paramValues = asArray(parameters).map((x) => String(x ?? "").trim());
  const hasVars = paramValues.length > 0;
  const messageType = templateMessageTypeFromHeaderFormat(
    normalizedHeader?.format || "",
    hasVars
  );
  const sval = templateSvalFromMessageType(messageType);

  const sample = {};
  if (paramValues.length) {
    sample.bodyvar = paramValues;
  }

  if (normalizedHeader?.id) {
    sample.media = normalizedHeader.id;
  }

  const payload = {
    message_type: messageType,
    sender: toE164Plus(sender),
    to: toE164Plus(to),
    template_id: providerTemplateId,
    ...(typeof sval === "number" ? { sval } : {}),
    ...(Object.keys(sample).length ? { sample } : {}),
  };

  return payload;
}

function isAbsoluteHttpUrl(v = "") {
  try {
    const u = new URL(String(v || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isClearlyUnsafeProxyTarget(v = "") {
  try {
    const u = new URL(String(v || "").trim());
    const host = String(u.hostname || "").toLowerCase();

    if (!["http:", "https:"].includes(u.protocol)) return true;
    if (!host) return true;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }
    if (host.endsWith(".local")) return true;

    return false;
  } catch {
    return true;
  }
}

function buildInboundMediaProxyUrl({
  url = "",
  mediaId = "",
  filename = "",
  mime = "",
}) {
  const qs = new URLSearchParams();
  if (url) qs.set("url", String(url || "").trim());
  if (mediaId) qs.set("mediaId", String(mediaId || "").trim());
  if (filename) qs.set("filename", sanitizeFilename(filename));
  if (mime) qs.set("mime", String(mime || "").trim());
  return `/api/whatsapp/media-proxy?${qs.toString()}`;
}

function getHostSafe(raw = "") {
  try {
    return new URL(String(raw || "").trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

function trustSignalHost() {
  return getHostSafe(TRUSTSIGNAL_API_BASE);
}

function isTrustSignalMediaUrl(raw = "") {
  const h = getHostSafe(raw);
  const tsHost = trustSignalHost();
  if (!h) return false;
  return h === tsHost || h.endsWith(".trustsignal.io");
}

async function ensurePublicMediaUrlReachable(url = "") {
  const target = String(url || "").trim();
  if (!isAbsoluteHttpUrl(target)) {
    const err = new Error("mediaUrl must be a public http/https URL");
    err.status = 400;
    throw err;
  }

  let resp;
  try {
    resp = await axios.get(target, {
      timeout: 20000,
      maxRedirects: 5,
      responseType: "stream",
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const err = new Error(
        `Uploaded media URL is not publicly reachable (${resp.status})`
      );
      err.status = 400;
      err.data = { mediaUrl: target, status: resp.status };
      throw err;
    }

    return {
      status: resp.status,
      contentType: String(resp.headers?.["content-type"] || "").trim(),
    };
  } finally {
    try {
      if (resp?.data && typeof resp.data.destroy === "function") {
        resp.data.destroy();
      }
    } catch { }
  }
}

async function fetchMediaStreamWithBestAuth(rawUrl) {
  const url = String(rawUrl || "").trim();
  const common = {
    url,
    responseType: "stream",
    timeout: 45000,
    validateStatus: () => true,
    maxRedirects: 5,
  };

  let resp = await axios.get(url, common);
  if (resp.status >= 200 && resp.status < 300) return resp;

  try {
    if (resp?.data && typeof resp.data.destroy === "function") {
      resp.data.destroy();
    }
  } catch { }

  if (isTrustSignalMediaUrl(url) && (resp.status === 401 || resp.status === 403)) {
    resp = await axios.get(url, {
      ...common,
      headers: buildHeaders(),
    });
    if (resp.status >= 200 && resp.status < 300) return resp;

    try {
      if (resp?.data && typeof resp.data.destroy === "function") {
        resp.data.destroy();
      }
    } catch { }

    resp = await axios.get(url, {
      ...common,
      headers: buildHeaders(),
      params: buildParams(),
    });
    if (resp.status >= 200 && resp.status < 300) return resp;
  }

  return resp;
}

async function fetchMediaBufferWithBestAuth(rawUrl) {
  const url = String(rawUrl || "").trim();
  const common = {
    url,
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 5,
  };

  let resp = await axios.get(url, common);
  if (resp.status >= 200 && resp.status < 300) return resp;

  if (isTrustSignalMediaUrl(url) && (resp.status === 401 || resp.status === 403)) {
    resp = await axios.get(url, {
      ...common,
      headers: buildHeaders(),
    });
    if (resp.status >= 200 && resp.status < 300) return resp;

    resp = await axios.get(url, {
      ...common,
      headers: buildHeaders(),
      params: buildParams(),
    });
    if (resp.status >= 200 && resp.status < 300) return resp;
  }

  return resp;
}

/* ----------------------------------------
   SOCKET EMITS
----------------------------------------- */
const roomForPhone10 = (p10) => `wa:${String(p10 || "").slice(-10)}`;

const emitToPhone10 = (req, phone10, event, payload) => {
  const io = req?.app?.get("io");
  if (!io) return;
  const p10 = last10(phone10);
  if (!p10) return;
  io.to(roomForPhone10(p10)).emit(event, payload);
};

const customerPhoneFromMsg = (msgDoc) => {
  const dir = String(msgDoc?.direction || "").toUpperCase();
  if (dir === "INBOUND") return msgDoc?.from;
  if (dir === "OUTBOUND") return msgDoc?.to;
  return msgDoc?.to || msgDoc?.from;
};

const emitMessage = (req, msgDoc) => {
  if (!msgDoc) return;
  const customerPhone = customerPhoneFromMsg(msgDoc);
  const p10 = last10(customerPhone || "");
  if (!p10) return;
  emitToPhone10(req, p10, "wa:message", { phone10: p10, message: msgDoc });
};

const emitStatus = (req, { phone10, waId, status, providerTransactionId }) => {
  if (!waId) return;
  const p10 = last10(phone10);
  if (!p10) return;
  emitToPhone10(req, p10, "wa:status", {
    phone10: p10,
    waId,
    status,
    ...(providerTransactionId ? { providerTransactionId } : {}),
  });
};

const emitConversationPatch = (req, { phone10, patch }) => {
  const p10 = last10(phone10);
  if (!p10) return;
  emitToPhone10(req, p10, "wa:conversation", {
    phone10: p10,
    phone: p10,
    patch,
  });
};

function freeformExpiryFromConvo(convo) {
  const t = convo?.lastInboundAt
    ? new Date(convo.lastInboundAt).getTime()
    : 0;
  if (!t) return null;
  return new Date(t + 24 * 60 * 60 * 1000);
}

function buildAutoReplyTranscript(messages = []) {
  return (messages || [])
    .slice()
    .reverse()
    .map((m) => {
      const dir =
        String(m?.direction || "").toUpperCase() === "OUTBOUND"
          ? "AGENT"
          : "CUSTOMER";
      const text = safeStr(m?.text);
      if (text) return `${dir}: ${text}`;
      const type = safeStr(m?.type || "message").toUpperCase();
      return `${dir}: [${type}]`;
    })
    .join("\n")
    .slice(0, 5000);
}

function appendAutoReplyAISignature(text = "", signatureText = "") {
  const base = safeStr(text);
  if (!base) return "";
  const signature = safeStr(signatureText || DEFAULT_AUTO_REPLY_AI_SIGNATURE);
  if (!signature) return base;
  if (base.endsWith(signature)) return base;
  return `${base}\n\n${signature}`;
}

async function generateSmartAutoReplyText({
  p10 = "",
  inboundAt = null,
  aiSignature = "",
}) {
  if (!AUTO_REPLY_AI_ENABLED || !openai || !p10) return "";

  const phoneRegex = new RegExp(`${p10}$`);
  const query = {
    $or: [{ from: phoneRegex }, { to: phoneRegex }],
  };
  if (inboundAt) {
    query.timestamp = { $lte: new Date(inboundAt) };
  }

  const recentMessages = await WhatsAppMessage.find(query)
    .sort({ timestamp: -1, createdAt: -1 })
    .limit(AUTO_REPLY_AI_MAX_CONTEXT_MESSAGES)
    .select("direction text type timestamp")
    .lean();

  if (!recentMessages.length) return "";

  const latestInbound = recentMessages.find(
    (m) =>
      String(m?.direction || "").toUpperCase() !== "OUTBOUND" &&
      safeStr(m?.text)
  );
  const customerQuestion = safeStr(latestInbound?.text);
  if (!customerQuestion) return "";

  const transcript = buildAutoReplyTranscript(recentMessages);
  const input = `
Customer asked on WhatsApp:
${customerQuestion}

Recent conversation:
${transcript || "(no transcript)"}

Write the next helpful support reply now.
`.trim();

  const instructions = `
You are an expert WhatsApp support assistant.

Rules:
- Reply with only the message text (no headings or markdown).
- Keep it concise and WhatsApp-friendly (2-6 lines).
- Directly answer the customer's latest question using plain language.
- If medical/legal/financial advice is requested, provide general guidance and suggest consulting a qualified professional.
- If required details are missing, ask at most one clarifying question.
- Do not mention internal delays, teams, tickets, or that you are an AI.
`.trim();

  try {
    const resp = await openai.responses.create({
      model: AUTO_REPLY_AI_MODEL,
      instructions,
      input,
      max_output_tokens: AUTO_REPLY_AI_MAX_OUTPUT_TOKENS,
    });
    return appendAutoReplyAISignature(
      safeStr(resp?.output_text),
      aiSignature
    ).slice(0, 1800);
  } catch (e) {
    console.error("[WA auto-reply] AI generation failed:", e?.message || e);
    return "";
  }
}

async function runAutoReplyWatchdog() {
  if (autoReplyWatchdogRunning || !AUTO_REPLY_CAN_SEND) {
    return;
  }
  autoReplyWatchdogRunning = true;

  try {
    const runtimeSettings = await getAutoReplyRuntimeSettings();
    if (!runtimeSettings.enabled) return;

    const sender = getTrustSignalSenderOrThrow();
    const delayMinutes = Math.max(1, Number(runtimeSettings.delayMinutes || 15));
    const cutoff = new Date(Date.now() - delayMinutes * 60 * 1000);

    const candidates = await WhatsAppConversation.find({
      lastInboundAt: { $ne: null, $lte: cutoff },
    })
      .select(
        "_id phone lastInboundAt lastOutboundAt autoReplyForInboundAt windowExpiresAt"
      )
      .lean();

    for (const convo of candidates || []) {
      const inboundAt = convo?.lastInboundAt ? new Date(convo.lastInboundAt) : null;
      if (!inboundAt || Number.isNaN(inboundAt.getTime())) continue;
      const previousAutoReplyForInboundAt = convo?.autoReplyForInboundAt
        ? new Date(convo.autoReplyForInboundAt)
        : null;

      const outboundAt = convo?.lastOutboundAt
        ? new Date(convo.lastOutboundAt)
        : null;

      // Agent already replied for this inbound cycle.
      if (outboundAt && outboundAt.getTime() >= inboundAt.getTime()) continue;

      const autoRepliedAt = convo?.autoReplyForInboundAt
        ? new Date(convo.autoReplyForInboundAt)
        : null;

      // Already auto-replied for this inbound cycle.
      if (autoRepliedAt && autoRepliedAt.getTime() >= inboundAt.getTime()) {
        continue;
      }

      const expiry =
        freeformExpiryFromConvo(convo) || convo?.windowExpiresAt || null;
      if (!expiry || new Date(expiry).getTime() < Date.now()) continue;

      const phone = normalizeWaId(convo?.phone || "");
      const p10 = last10(phone);
      if (!phone || !p10) continue;

      try {
        // Atomically claim this inbound cycle before generating/sending to prevent
        // duplicate auto-replies from concurrent watchdog runs/processes.
        const claimResult = await WhatsAppConversation.updateOne(
          {
            _id: convo._id,
            lastInboundAt: inboundAt,
            $and: [
              {
                $or: [
                  { lastOutboundAt: null },
                  { lastOutboundAt: { $lt: inboundAt } },
                ],
              },
              {
                $or: [
                  { autoReplyForInboundAt: null },
                  { autoReplyForInboundAt: { $lt: inboundAt } },
                ],
              },
            ],
          },
          {
            $set: {
              autoReplyForInboundAt: inboundAt,
            },
          }
        );

        const claimed = Boolean(
          claimResult?.modifiedCount || claimResult?.nModified
        );
        if (!claimed) {
          continue;
        }

        const aiReplyText = await generateSmartAutoReplyText({
          p10,
          inboundAt,
          aiSignature: runtimeSettings.aiSignature,
        });
        const replyText = aiReplyText || AUTO_REPLY_TEXT;
        if (!replyText) continue;

        const toNumber = getTrustSignalRecipient(phone);
        const r = await sendFreeformTextViaTrustSignal({
          sender,
          toNumber,
          text: replyText,
        });
        ensureTrustSignalAccepted(
          r.data,
          "TrustSignal did not accept auto-reply send"
        );

        const now = new Date();
        await WhatsAppMessage.create({
          waId: extractProviderAcceptId(r.data),
          providerTransactionId: extractProviderTransactionId(r.data),
          from: senderForDb(sender),
          to: phone,
          text: replyText,
          direction: "OUTBOUND",
          type: "text",
          status: "sent",
          timestamp: now,
          raw: {
            ...(r.data || {}),
            autoReply: true,
            autoReplyMode: aiReplyText ? "ai" : "fallback",
          },
        });

        await WhatsAppConversation.updateOne(
          {
            _id: convo._id,
            $or: [{ lastOutboundAt: null }, { lastOutboundAt: { $lt: inboundAt } }],
          },
          {
            $set: {
              lastMessageAt: now,
              lastMessageText: replyText.slice(0, 200),
              lastOutboundAt: now,
              autoReplySentAt: now,
              autoReplyForInboundAt: inboundAt,
            },
          }
        );

        console.log(
          `[WA auto-reply] sent (${aiReplyText ? "ai" : "fallback"}) to ${p10} after ${delayMinutes}m inactivity`
        );
      } catch (sendErr) {
        // Release claim so watchdog can retry this inbound cycle later.
        try {
          await WhatsAppConversation.updateOne(
            {
              _id: convo._id,
              autoReplyForInboundAt: inboundAt,
              $or: [{ lastOutboundAt: null }, { lastOutboundAt: { $lt: inboundAt } }],
            },
            {
              $set: {
                autoReplyForInboundAt:
                  previousAutoReplyForInboundAt &&
                  !Number.isNaN(previousAutoReplyForInboundAt.getTime())
                    ? previousAutoReplyForInboundAt
                    : null,
              },
            }
          );
        } catch (releaseErr) {
          console.error(
            `[WA auto-reply] release claim failed for ${p10}:`,
            releaseErr?.message || releaseErr
          );
        }
        console.error(
          `[WA auto-reply] failed for ${p10}:`,
          sendErr?.message || sendErr
        );
      }
    }
  } catch (e) {
    console.error("[WA auto-reply] watchdog error:", e?.message || e);
  } finally {
    autoReplyWatchdogRunning = false;
  }
}

function normalizeDeliveryStatus(status = "") {
  const s = String(status || "").toLowerCase().trim();
  if (!s) return s;
  if (["read", "seen"].includes(s) || s.includes("read") || s.includes("seen")) return "read";
  if (
    ["delivered", "deliver", "received"].includes(s) ||
    s.includes("deliver") ||
    s.includes("receive")
  ) return "delivered";
  if (
    ["sent", "submitted", "queued", "accepted"].includes(s) ||
    s.includes("sent") ||
    s.includes("submit") ||
    s.includes("queue") ||
    s.includes("accept")
  ) return "sent";
  if (
    ["failed", "error", "undelivered", "rejected"].includes(s) ||
    s.includes("fail") ||
    s.includes("error") ||
    s.includes("reject") ||
    s.includes("undeliver")
  ) return "failed";
  return s;
}

function deliveryStatusRank(status = "") {
  const s = normalizeDeliveryStatus(status);
  if (s === "failed") return 99;
  if (s === "read") return 3;
  if (s === "delivered") return 2;
  if (s === "sent") return 1;
  return 0;
}

function isKnownDeliveryStatus(status = "") {
  return deliveryStatusRank(status) > 0;
}

/* ----------------------------------------
   TRUSTSIGNAL REQUESTS
----------------------------------------- */
async function tsRequest({
  method = "GET",
  path = "",
  pathParams = {},
  params = {},
  data = undefined,
  headers = {},
  responseType = undefined,
}) {
  const finalPath = compilePath(path, pathParams);
  const finalUrl = `${TRUSTSIGNAL_API_BASE}${finalPath}`;

  console.log("TS REQUEST =>", method, finalUrl, buildParams(params));
  if (data !== undefined) {
    console.log(
      "TS BODY =>",
      data instanceof FormData ? "[form-data]" : safeStringify(data)
    );
  }

  const resp = await trustsignalClient.request({
    method,
    url: finalPath,
    params: buildParams(params),
    data,
    headers: buildHeaders(headers),
    ...(responseType ? { responseType } : {}),
  });

  okOrThrow(resp);

  if (!responseType && isHtmlLikeResponse(resp.data, resp.headers || {})) {
    const err = new Error("Received HTML page instead of API JSON");
    err.status = 502;
    err.data =
      typeof resp.data === "string" ? resp.data.slice(0, 1000) : resp.data;
    throw err;
  }

  return resp;
}

async function sendFreeformTextViaTrustSignal({ sender, toNumber, text }) {
  const textValue = String(text || "").trim();

  const payload = {
    message_type: "text",
    sender: toE164Plus(sender),
    to: toE164Plus(toNumber),
    reply: {
      message: textValue,
    },
  };

  return tsRequest({
    method: "POST",
    path: TS_PATH_SEND_REPLY,
    data: payload,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendFreeformMediaViaTrustSignal({
  sender,
  toNumber,
  caption,
  mediaType,
  mediaUrl,
  filename,
}) {
  const resolvedType = normalizeOutgoingMediaType(mediaType);

  const payload = {
    message_type: "file",
    sender: toE164Plus(sender),
    to: toE164Plus(toNumber),
    reply: {
      message: String(caption || "").trim(),
      media_type: resolvedType,
      media_file_url: String(mediaUrl || "").trim(),
      ...(filename ? { filename } : {}),
    },
  };

  console.log("TS MEDIA PAYLOAD =>", JSON.stringify(payload, null, 2));

  return tsRequest({
    method: "POST",
    path: TS_PATH_SEND_REPLY,
    data: payload,
    headers: { "Content-Type": "application/json" },
  });
}

/* ----------------------------------------
   WASABI HELPERS
----------------------------------------- */
async function uploadBufferToWasabi({
  buffer,
  mime,
  filename,
  keyPrefix,
}) {
  if (!s3 || !WASABI_BUCKET) {
    const err = new Error("Wasabi is not configured properly.");
    err.status = 500;
    throw err;
  }

  const safeName = sanitizeFilename(filename || "");
  const ext = path.extname(safeName) || `.${extFromMime(mime)}`;
  const finalName =
    safeName || `file_${Date.now()}${ext.startsWith(".") ? ext : `.${ext}`}`;

  const key = `${keyPrefix}/${Date.now()}_${finalName}`;

  const up = await s3
    .upload({
      Bucket: WASABI_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime || "application/octet-stream",
      ContentDisposition: `inline; filename="${finalName}"`,
      CacheControl: "public, max-age=31536000",
      ACL: "public-read",
    })
    .promise();

  const publicUrl = up?.Location || buildWasabiPublicUrl(key);
  if (!publicUrl) {
    const err = new Error("Wasabi upload succeeded but URL could not be built.");
    err.status = 500;
    throw err;
  }

  return {
    key,
    url: publicUrl,
    filename: finalName,
    mime: mime || "application/octet-stream",
  };
}

async function uploadOutboundToWasabi({ buffer, mime, filename, to10 }) {
  const day = new Date().toISOString().slice(0, 10);
  return uploadBufferToWasabi({
    buffer,
    mime,
    filename,
    keyPrefix: `whatsapp-outbound/${day}/${to10 || "unknown"}`,
  });
}

async function maybeMirrorInboundMediaToWasabi({
  url,
  mediaId,
  mime,
  filename,
  from10,
  msgType,
}) {
  const mediaUrl = String(url || "").trim();
  const mediaIdValue = String(mediaId || "").trim();

  if (mediaUrl && WASABI_ENDPOINT && mediaUrl.startsWith(WASABI_ENDPOINT)) {
    return mediaUrl;
  }

  if (!s3 || !WASABI_BUCKET) {
    return "";
  }

  try {
    let resp;
    let bestMime = String(mime || "").trim();

    if (mediaUrl) {
      resp = await fetchMediaBufferWithBestAuth(mediaUrl);
      bestMime =
        String(resp.headers?.["content-type"] || bestMime || "").trim() ||
        "application/octet-stream";
    } else {
      return "";
    }

    if (!resp || resp.status < 200 || resp.status >= 300) {
      console.error(
        "Inbound mirror fetch failed:",
        resp?.status,
        mediaIdValue || mediaUrl
      );
      return "";
    }

    bestMime = bestMime || "application/octet-stream";

    const day = new Date().toISOString().slice(0, 10);
    const finalFilename =
      sanitizeFilename(filename || "") ||
      `${msgType || "media"}_${from10 || "unknown"}_${mediaIdValue || Date.now()
      }.${extFromMime(bestMime)}`;

    const uploaded = await uploadBufferToWasabi({
      buffer: Buffer.from(resp.data),
      mime: bestMime,
      filename: finalFilename,
      keyPrefix: `whatsapp-inbound/${day}/${from10 || "unknown"}`,
    });

    return uploaded.url || "";
  } catch (e) {
    console.error("Inbound mirror to Wasabi failed:", e?.message || e);
    return "";
  }
}

/* ----------------------------------------
   WEBHOOK PARSER
----------------------------------------- */
function textFromInboundMessage(msg = {}) {
  return (
    String(
      deepPick(msg, [
        "text.body",
        "text",
        "message",
        "body",
        "content.text",
        "payload.text",
        "interactive.button_reply.title",
        "interactive.list_reply.title",
        "button.text",
        "button.payload",
      ]) || ""
    ).trim() || ""
  );
}

function mediaFromInboundMessage(msg = {}, item = {}) {
  const rawType = String(
    deepPick(msg, ["type", "message_type", "content.type", "payload.type"]) ||
    "text"
  ).toLowerCase();

  const node =
    deepPick(msg, [
      `${rawType}`,
      "file",
      "media",
      "content.media",
      "payload.media",
      "document",
      "image",
      "audio",
      "video",
      "sticker",
    ]) || {};

  const mediaId = String(
    deepPick(node, ["id", "media_id"]) ||
    deepPick(msg, ["media_id"]) ||
    ""
  ).trim();

  const trustedTopLevelUrl = String(item?.__fileurl || "").trim();

  const nestedUrl = String(
    deepPick(node, ["download_url", "link", "media_file_url", "url"]) ||
    deepPick(msg, ["download_url", "fileurl", "media_file_url", "url"]) ||
    ""
  ).trim();

  const url = trustedTopLevelUrl || nestedUrl;

  const mime = String(
    deepPick(node, ["mime_type", "mime", "content_type"]) ||
    deepPick(msg, ["mime_type", "mime", "content_type"]) ||
    ""
  ).trim();

  const filename = String(
    deepPick(node, ["filename", "file_name", "name"]) ||
    deepPick(msg, ["filename", "file_name", "name"]) ||
    ""
  ).trim();

  if (!mediaId && !url && !mime && !filename) {
    return {
      id: "",
      url: "",
      mime: "",
      filename: "",
      type: "",
    };
  }

  return {
    id: mediaId,
    url,
    mime,
    filename,
    type: rawType,
  };
}

function parseWebhookPayload(body = {}) {
  const buckets = [];
  const topWebhookType = String(body?.webhook_type || "").trim();
  const topTransactionId = String(
    deepPick(body, [
      "transaction_id",
      "transactionId",
      "data.transaction_id",
      "data.transactionId",
    ]) || ""
  ).trim();
  const topFileUrl = String(
    deepPick(body, ["fileurl", "value.fileurl", "data.fileurl"]) || ""
  ).trim();
  const topAcid = String(body?.acid || "").trim();

  if (Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        buckets.push({
          ...(change?.value || {}),
          __webhook_type: change?.webhook_type || topWebhookType || "",
          __fileurl: String(
            deepPick(change, ["fileurl", "value.fileurl"]) || topFileUrl || ""
          ).trim(),
          __acid: change?.acid || topAcid || "",
          __transaction_id: String(
            deepPick(change, [
              "transaction_id",
              "transactionId",
              "value.transaction_id",
              "value.transactionId",
            ]) || topTransactionId || ""
          ).trim(),
        });
      }
    }
  } else if (Array.isArray(body?.events)) {
    for (const ev of body.events) {
      buckets.push({
        ...(ev || {}),
        __webhook_type: ev?.webhook_type || topWebhookType || "",
        __fileurl: String(ev?.fileurl || topFileUrl || "").trim(),
        __acid: ev?.acid || topAcid || "",
        __transaction_id: String(
          ev?.transaction_id || ev?.transactionId || topTransactionId || ""
        ).trim(),
      });
    }
  } else if (body?.value && isObjectLike(body.value)) {
    buckets.push({
      ...(body.value || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: String(
        deepPick(body, ["value.fileurl", "fileurl"]) || ""
      ).trim(),
      __acid: topAcid || "",
      __transaction_id: topTransactionId || "",
    });
  } else if (body?.data || body?.messages || body?.statuses) {
    buckets.push({
      ...(body.data || body),
      __webhook_type: topWebhookType || "",
      __fileurl: String(
        deepPick(body, ["data.fileurl", "fileurl"]) || ""
      ).trim(),
      __acid: topAcid || "",
      __transaction_id: topTransactionId || "",
    });
  } else {
    buckets.push({
      ...(body || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
      __transaction_id: topTransactionId || "",
    });
  }

  const out = { businessPhone: "", statuses: [], messages: [] };

  for (const item of buckets) {
    const businessPhone = normalizeWaId(
      deepPick(item, [
        "metadata.display_phone_number",
        "business_phone",
        "phone_number",
        "sender",
        "channel.phone",
      ]) || ""
    );
    if (businessPhone && !out.businessPhone) out.businessPhone = businessPhone;

    const enrichStatusCandidate = (candidate) => ({
      ...(isObjectLike(candidate) ? candidate : { status: candidate }),
      __webhook_type:
        candidate?.__webhook_type ||
        candidate?.webhook_type ||
        item?.__webhook_type ||
        item?.webhook_type ||
        topWebhookType ||
        "",
      __acid: candidate?.__acid || candidate?.acid || item?.__acid || item?.acid || topAcid || "",
      __transaction_id:
        candidate?.__transaction_id ||
        candidate?.transaction_id ||
        candidate?.transactionId ||
        item?.__transaction_id ||
        item?.transaction_id ||
        item?.transactionId ||
        topTransactionId ||
        "",
      __phone: deepPick(candidate, ["to", "recipient_id", "phone", "customer_phone"]) ||
        deepPick(item, ["to", "recipient_id", "phone", "customer_phone", "results.to", "data.results.to"]) ||
        "",
    });

    const statusContainers = [];
    if (item?.statuses) statusContainers.push(...asArray(item.statuses).map(enrichStatusCandidate));
    if (item?.status_updates) statusContainers.push(...asArray(item.status_updates).map(enrichStatusCandidate));
    if (item?.statusUpdates) statusContainers.push(...asArray(item.statusUpdates).map(enrichStatusCandidate));
    if (item?.delivery_statuses) statusContainers.push(...asArray(item.delivery_statuses).map(enrichStatusCandidate));
    if (item?.deliveryStatuses) statusContainers.push(...asArray(item.deliveryStatuses).map(enrichStatusCandidate));
    if (isObjectLike(item?.status)) statusContainers.push(...asArray(item.status).map(enrichStatusCandidate));

    const directStatus = normalizeDeliveryStatus(
      deepPick(item, [
        "status",
        "state",
        "event",
        "message_status",
        "messageStatus",
        "delivery_status",
        "deliveryStatus",
        "webhook_type",
        "__webhook_type",
      ]) || ""
    );
    const directStatusId = String(
      deepPick(item, [
        "id",
        "wa_id",
        "message_id",
        "results.message_id",
        "results.0.message_id",
        "data.message_id",
        "data.results.message_id",
        "data.results.0.message_id",
        "acid",
        "__acid",
      ]) || ""
    ).trim();
    const directTransactionId = String(
      deepPick(item, [
        "acid",
        "__acid",
        "__transaction_id",
        "transaction_id",
        "transactionId",
        "results.transaction_id",
        "results.0.transaction_id",
        "data.transaction_id",
        "data.transactionId",
        "data.results.transaction_id",
        "data.results.0.transaction_id",
        "result.transaction_id",
      ]) || ""
    ).trim();

    if (isKnownDeliveryStatus(directStatus) && (directStatusId || directTransactionId)) {
      statusContainers.push(enrichStatusCandidate(item));
    }

    for (const st of statusContainers) {
      const waId = String(
        deepPick(st, [
          "id",
          "wa_id",
          "message_id",
          "results.message_id",
          "results.0.message_id",
          "data.message_id",
          "data.results.message_id",
          "data.results.0.message_id",
          "acid",
          "__acid",
        ]) || ""
      ).trim();

      const transactionId = String(
        deepPick(st, [
          "acid",
          "__acid",
          "__transaction_id",
          "transaction_id",
          "transactionId",
          "results.transaction_id",
          "results.0.transaction_id",
          "data.transaction_id",
          "data.transactionId",
          "data.results.transaction_id",
          "data.results.0.transaction_id",
          "result.transaction_id",
        ]) || ""
      ).trim();

      const status = normalizeDeliveryStatus(
        deepPick(st, [
          "status",
          "state",
          "event",
          "message_status",
          "messageStatus",
          "delivery_status",
          "deliveryStatus",
          "webhook_type",
          "__webhook_type",
        ]) || ""
      );

      const phone = normalizeWaId(
        deepPick(st, [
          "recipient_id",
          "to",
          "phone",
          "customer_phone",
          "recipient",
          "destination",
          "mobile",
          "msisdn",
          "results.to",
          "data.results.to",
          "__phone",
        ]) || ""
      );

      if (isKnownDeliveryStatus(status) && (waId || transactionId)) {
        out.statuses.push({
          waId,
          transactionId,
          status,
          phone,
          errors: Array.isArray(st?.errors) ? st.errors : [],
          raw: st,
        });
      }
    }

    const messages = asArray(
      item?.messages || item?.message || item?.inbound_messages || []
    );

    for (const msg of messages) {
      const waId = String(
        deepPick(msg, ["id", "wa_id", "message_id"]) || ""
      ).trim();

      const from = normalizeWaId(
        deepPick(msg, ["from", "customer.phone", "sender"]) ||
        deepPick(item, ["contacts.0.wa_id"]) ||
        ""
      );

      const timestampRaw = deepPick(msg, ["timestamp", "time", "created_at"]);
      const timestamp = timestampRaw
        ? new Date(
          Number(timestampRaw) ? Number(timestampRaw) * 1000 : timestampRaw
        )
        : new Date();

      const text = textFromInboundMessage(msg);
      const media = mediaFromInboundMessage(msg, item);

      const normalizedMedia = {
        id: media.id || "",
        url: media.url || "",
        mime: media.mime || "",
        filename: media.filename || "",
      };

      const rawType = String(
        deepPick(msg, ["type", "message_type", "content.type"]) ||
        media.type ||
        "text"
      ).toLowerCase();

      const isRealMedia = hasRealMedia(normalizedMedia);

      const safeType = isRealMedia
        ? inferMediaType({
          type: rawType,
          mime: normalizedMedia.mime,
          filename: normalizedMedia.filename,
          url: normalizedMedia.url,
        })
        : "text";

      out.messages.push({
        waId,
        from,
        to: businessPhone || out.businessPhone || "",
        text,
        type: safeType,
        ...(isRealMedia ? { media: normalizedMedia } : {}),
        raw: msg,
        timestamp,
      });
    }
  }

  return out;
}

/* ----------------------------------------
   ROUTES
----------------------------------------- */
router.get("/media-proxy", async (req, res) => {
  let upstream;

  try {
    const rawUrl = String(req.query?.url || "").trim();
    const mediaId = String(req.query?.mediaId || "").trim();
    const filename = sanitizeFilename(req.query?.filename || "attachment");
    const fallbackMime = String(req.query?.mime || "").trim();

    if (!rawUrl && !mediaId) {
      return res.status(400).json({ message: "url or mediaId required" });
    }

    if (rawUrl) {
      if (!isAbsoluteHttpUrl(rawUrl) || isClearlyUnsafeProxyTarget(rawUrl)) {
        return res.status(400).json({ message: "invalid media url" });
      }

      if (WASABI_ENDPOINT && rawUrl.startsWith(WASABI_ENDPOINT)) {
        return res.redirect(rawUrl);
      }
    }

    upstream = await fetchMediaStreamWithBestAuth(rawUrl);
    console.log(
      "media-proxy upstream status:",
      upstream.status,
      rawUrl,
      mediaId || ""
    );

    if (upstream.status < 200 || upstream.status >= 300) {
      try {
        if (upstream.data && typeof upstream.data.destroy === "function") {
          upstream.data.destroy();
        }
      } catch { }

      return res.status(502).json({
        message: "Failed to fetch provider media",
        providerStatus: upstream.status,
      });
    }

    const contentType =
      String(upstream.headers?.["content-type"] || "").trim() ||
      fallbackMime ||
      "application/octet-stream";

    const contentLength = String(
      upstream.headers?.["content-length"] || ""
    ).trim();

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename || "attachment"}"`
    );
    res.setHeader("Cache-Control", "private, max-age=300");

    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    upstream.data.on("error", (err) => {
      console.error("media-proxy stream error:", err?.message || err);
      if (!res.headersSent) {
        res.status(502).end("media proxy stream failed");
      } else {
        res.end();
      }
    });

    return upstream.data.pipe(res);
  } catch (e) {
    console.error("media-proxy error:", e?.message || e);
    return res.status(502).json({
      message: "Media proxy failed",
      error: e?.message || "UNKNOWN_ERROR",
    });
  }
});

router.post(
  "/upload-template-media",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "file required" });
      }

      const fd = new FormData();
      fd.append("file", req.file.buffer, {
        filename: req.file.originalname || "file",
        contentType: req.file.mimetype || "application/octet-stream",
        knownLength: req.file.size,
      });

      const r = await tsRequest({
        method: "POST",
        path: TS_PATH_UPLOAD_MEDIA,
        data: fd,
        headers: fd.getHeaders(),
      });

      const mediaId = extractProviderMediaId(r.data);
      if (!mediaId) {
        return res.status(400).json({
          message: "Upload succeeded but provider did not return media id",
          providerError: r.data || null,
        });
      }

      return res.json({ success: true, mediaId });
    } catch (e) {
      console.error("upload-template-media error:", e?.data || e);
      return res.status(e?.status || e?.response?.status || 400).json({
        message: e?.message || "Upload template media failed",
        providerError: e?.data || e?.response?.data || null,
      });
    }
  }
);

router.post("/conversations/mark-read", async (req, res) => {
  try {
    const phoneRaw = req.body?.phone || "";
    const p10 = last10(phoneRaw);
    if (!p10) return res.status(400).json({ message: "phone required" });

    const now = new Date();

    const updated = await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      { $set: { unreadCount: 0, lastReadAt: now } },
      { new: true }
    ).lean();

    emitConversationPatch(req, {
      phone10: p10,
      patch: { unreadCount: 0, lastReadAt: now },
    });

    return res.json({ success: true, conversation: updated || null });
  } catch (e) {
    console.error("mark-read error:", e);
    return res.status(500).json({ message: e.message || "mark-read failed" });
  }
});

router.get("/conversations", async (req, res) => {
  try {
    const { role, userName, userId, hasTeam, chatScope } = req.query;

    const conversations = await WhatsAppConversation.find({})
      .sort({ lastMessageAt: -1 })
      .lean();

    if (!conversations.length) return res.json([]);

    const phones10 = conversations.map((c) => last10(c.phone));

    const [leads, customers] = await Promise.all([
      Lead.find({ contactNumber: { $in: phones10 } })
        .select("contactNumber name healthExpertAssigned agentAssigned")
        .lean(),
      Customer.find({ phone: { $in: phones10 } })
        .select("phone name assignedTo")
        .lean(),
    ]);

    const leadMap = {};
    leads.forEach((l) => {
      leadMap[last10(l.contactNumber)] = l;
    });

    const customerMap = {};
    customers.forEach((c) => {
      customerMap[last10(c.phone)] = c;
    });

    let enriched = conversations.map((conv) => {
      const p10 = last10(conv.phone);
      const lead = leadMap[p10];
      const customer = customerMap[p10];

      let displayName = p10;
      let assignedToLabel = "Unassigned";

      if (lead) {
        displayName = lead.name || p10;
        assignedToLabel =
          lead.healthExpertAssigned || lead.agentAssigned || "Unassigned";
      } else if (customer) {
        displayName = customer.name || p10;
        assignedToLabel = customer.assignedTo || "Unassigned";
      }

      return { ...conv, displayName, assignedToLabel };
    });

    const r = String(role || "");
    const normalizedRole = String(role || "").trim().toLowerCase();
    const normalizedUserName = String(userName || "").trim().toLowerCase();
    const scope = String(chatScope || "").trim().toLowerCase();
    const isAdmin =
      ["Manager", "Developer", "Super Admin", "Admin"].includes(r) ||
      r.toLowerCase().includes("admin") ||
      r.toLowerCase().includes("manager");

    const isAssistantTeamLeadLike =
      (normalizedRole === "assistant team lead" ||
        normalizedRole === "retention agent");
    const isTeamLeaderLike =
      (normalizedRole === "team leader" || normalizedRole === "team-leader");
    const userHasTeam =
      String(hasTeam || "").trim().toLowerCase() === "true" ||
      isAssistantTeamLeadLike ||
      isTeamLeaderLike;

    if (userHasTeam && (normalizedUserName || String(userId || "").trim())) {
      let employee = null;
      const rawUserId = String(userId || "").trim();

      if (mongoose.Types.ObjectId.isValid(rawUserId)) {
        employee = await Employee.findById(rawUserId)
          .select("_id fullName teamMembers")
          .lean();
      }

      if (!employee && normalizedUserName) {
        employee = await Employee.findOne({
          fullName: {
            $regex: new RegExp(
              `^${String(userName).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              "i"
            ),
          },
        })
          .select("_id fullName teamMembers")
          .lean();
      }

      if (employee?._id) {
        const employeeNameNormalized = String(employee?.fullName || "")
          .trim()
          .toLowerCase();
        let directReports = await Employee.find({
          teamLeader: employee._id,
          status: "active",
        })
          .select("fullName")
          .lean();

        if (!directReports.length) {
          directReports = await Employee.find({
            teamLeader: employee._id,
          })
            .select("fullName")
            .lean();
        }

        if (!directReports.length && Array.isArray(employee?.teamMembers) && employee.teamMembers.length) {
          directReports = await Employee.find({
            _id: { $in: employee.teamMembers },
            status: "active",
          })
            .select("fullName")
            .lean();

          if (!directReports.length) {
            directReports = await Employee.find({
              _id: { $in: employee.teamMembers },
            })
              .select("fullName")
              .lean();
          }
        }

        const teamNames = new Set(
          (directReports || [])
            .map((emp) => String(emp?.fullName || "").trim().toLowerCase())
            .filter(Boolean)
        );

        const filterByNames = (allowedNames) =>
          enriched.filter((chat) =>
            allowedNames.has(String(chat.assignedToLabel || "").trim().toLowerCase())
          );

        if (scope === "team" || (isTeamLeaderLike && !scope)) {
          if (teamNames.size > 0) {
            enriched = filterByNames(teamNames);
            return res.json(enriched);
          }
          // Team leader fallback: if no resolvable team members, at least return self chats.
          const fallbackSelf = employeeNameNormalized || normalizedUserName;
          if (fallbackSelf) {
            enriched = enriched.filter(
              (chat) =>
                String(chat.assignedToLabel || "").trim().toLowerCase() ===
                fallbackSelf
            );
          }
          return res.json(enriched);
        }

        if (scope === "self") {
          enriched = enriched.filter(
            (chat) =>
              String(chat.assignedToLabel || "").trim().toLowerCase() ===
              (employeeNameNormalized || normalizedUserName)
          );
          return res.json(enriched);
        }

        if (
          scope === "combined" ||
          (!scope && isAssistantTeamLeadLike)
        ) {
          const combined = new Set(teamNames);
          combined.add(employeeNameNormalized || normalizedUserName);
          enriched = filterByNames(combined);
          return res.json(enriched);
        }
      }
    }

    if (!isAdmin) {
      enriched = enriched.filter(
        (chat) =>
          String(chat.assignedToLabel || "").trim().toLowerCase() ===
          normalizedUserName
      );
    }

    return res.json(enriched);
  } catch (e) {
    console.error("Conversation load error:", e);
    return res.status(500).json({ message: "Failed to load conversations" });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const q = digitsOnly(req.query.phone);
    if (!q) return res.status(400).json({ message: "phone required" });
    const limitRaw = Number(req.query.limit || 0);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(100, Math.floor(limitRaw))
      : null;
    const beforeRaw = String(req.query.before || "").trim();
    const beforeDate = beforeRaw ? new Date(beforeRaw) : null;

    const waId = normalizeWaId(q);
    const l10 = waId.slice(-10);

    const baseQuery = {
      $or: [
        { from: waId },
        { to: waId },
        { from: new RegExp(`${l10}$`) },
        { to: new RegExp(`${l10}$`) },
      ],
    };
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) {
      baseQuery.timestamp = { $lt: beforeDate };
    }

    const query = WhatsAppMessage.find(baseQuery)
      .sort(limit ? { timestamp: -1, createdAt: -1 } : { timestamp: 1, createdAt: 1 });
    if (limit) query.limit(limit);
    const msgs = await query.lean();
    const rows = limit ? msgs.slice().reverse() : msgs;

    const byIdentity = new Map();
    for (const msg of rows || []) {
      const k = messageIdentityKeyForList(msg);
      const prev = byIdentity.get(k);
      if (!prev) {
        byIdentity.set(k, msg);
        continue;
      }
      const prevStatus = deliveryStatusRank(prev?.status);
      const nextStatus = deliveryStatusRank(msg?.status);
      if (nextStatus >= prevStatus) {
        byIdentity.set(k, { ...prev, ...msg });
      }
    }
    return res.json(Array.from(byIdentity.values()));
  } catch (e) {
    console.error("load messages error:", e);
    return res.status(500).json({ message: "Failed to load messages" });
  }
});

router.get("/templates", async (req, res) => {
  try {
    const tpls = await WhatsAppTemplate.find({})
      .sort({ updatedAt: -1 })
      .lean();
    return res.json(tpls || []);
  } catch (e) {
    console.error("load templates error:", e);
    return res.status(500).json({ message: "Failed to load templates" });
  }
});

router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    const textValue = String(text || "").trim();

    if (!to || !textValue) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const convo = await WhatsAppConversation.findOne({
      phone: new RegExp(`${p10}$`),
    }).lean();

    const expiry =
      freeformExpiryFromConvo(convo) || convo?.windowExpiresAt || null;

    if (!expiry || expiry < new Date()) {
      return res.status(400).json({
        message: "Session expired. Use template message.",
        code: "SESSION_EXPIRED",
      });
    }

    const sender = getTrustSignalSenderOrThrow();
    const toNumber = getTrustSignalRecipient(phone);

    const r = await sendFreeformTextViaTrustSignal({
      sender,
      toNumber,
      text: textValue,
    });

    ensureTrustSignalAccepted(r.data, "TrustSignal did not accept text send");

    const now = new Date();

    const created = await WhatsAppMessage.create({
      waId: extractProviderAcceptId(r.data),
      providerTransactionId: extractProviderTransactionId(r.data),
      from: senderForDb(sender),
      to: phone,
      text: textValue,
      direction: "OUTBOUND",
      type: "text",
      status: "sent",
      timestamp: now,
      raw: r.data,
    });

    await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone,
          lastMessageAt: now,
          lastMessageText: textValue.slice(0, 200),
          lastOutboundAt: now,
        },
      },
      { upsert: true }
    );

    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: now,
        lastMessageText: textValue.slice(0, 200),
        lastOutboundAt: now,
      },
    });

    return res.json({ success: true, providerResponse: r.data || null });
  } catch (e) {
    const status = e?.status || e?.response?.status || 400;
    const data = e?.data || e?.response?.data || null;

    const countryBlocked = findProviderError(
      data,
      (x) =>
        String(x?.code || "") === "1013" ||
        String(x?.codeMsg || "").toUpperCase() ===
        "WHATSAPP_COUNTRY_NOT_ALLOWED"
    );

    if (countryBlocked) {
      return res.status(400).json({
        success: false,
        code: "WHATSAPP_COUNTRY_NOT_ALLOWED",
        message:
          "Send text failed: this TrustSignal sender/account is not enabled to send WhatsApp messages to this destination country.",
        providerError: data,
      });
    }

    const templateRequired = findProviderError(
      data,
      (x) =>
        String(x?.code || "") === "119" ||
        String(x?.codeMsg || "").toUpperCase() === "TEMPLATE_NOT_APPROVED" ||
        String(x?.message || "")
          .toLowerCase()
          .includes("template id is required")
    );

    if (templateRequired) {
      return res.status(400).json({
        success: false,
        code: "TEXT_PAYLOAD_REJECTED",
        message:
          "Send text failed: TrustSignal is rejecting the freeform text payload on the current endpoint.",
        providerError: data,
      });
    }

    console.error("Send text error:", { status, data, message: e?.message });

    return res.status(status).json({
      success: false,
      message: "Send text failed",
      providerError: data || { error: e?.message },
    });
  }
});

router.post("/send-media", upload.single("file"), async (req, res) => {
  try {
    const toRaw = req.body?.to || "";
    const caption = String(req.body?.caption || req.body?.message || "").trim();
    const directMediaUrl = String(req.body?.mediaUrl || "").trim();
    const directFilename = String(req.body?.filename || "").trim();
    const directMime = String(req.body?.mime || "").trim();
    const directType = String(req.body?.mediaType || "")
      .trim()
      .toLowerCase();

    if (!toRaw) {
      return res.status(400).json({ message: "to required" });
    }

    if (!req.file && !directMediaUrl) {
      return res.status(400).json({ message: "file or mediaUrl required" });
    }

    const phone = normalizeWaId(toRaw);
    const p10 = last10(phone);

    const convo = await WhatsAppConversation.findOne({
      phone: new RegExp(`${p10}$`),
    }).lean();

    const expiry =
      freeformExpiryFromConvo(convo) || convo?.windowExpiresAt || null;

    if (!expiry || expiry < new Date()) {
      return res.status(400).json({
        message: "Session expired. Use template message.",
        code: "SESSION_EXPIRED",
      });
    }

    const sender = getTrustSignalSenderOrThrow();
    const toNumber = getTrustSignalRecipient(phone);

    let mediaUrl = directMediaUrl;
    let filename = sanitizeFilename(directFilename || "");
    let mime = directMime;
    let mediaType = directType;

    if (req.file) {
      mime = req.file.mimetype || "application/octet-stream";
      filename = sanitizeFilename(req.file.originalname || "attachment");
      mediaType = normalizeOutgoingMediaType(
        mediaType ||
        inferMediaType({
          type: mediaType,
          mime,
          filename,
          url: "",
        })
      );

      const uploaded = await uploadOutboundToWasabi({
        buffer: req.file.buffer,
        mime,
        filename,
        to10: p10,
      });

      mediaUrl = uploaded.url;
      filename = uploaded.filename;
      mime = uploaded.mime;
    } else {
      mediaType = normalizeOutgoingMediaType(
        mediaType ||
        inferMediaType({
          type: mediaType,
          mime,
          filename,
          url: mediaUrl,
        })
      );

      if (!filename) {
        filename = sanitizeFilename(
          path.basename(mediaUrl.split("?")[0] || "attachment")
        );
      }
    }

    if (!isAbsoluteHttpUrl(mediaUrl)) {
      return res.status(400).json({ message: "mediaUrl must be a public URL" });
    }

    await ensurePublicMediaUrlReachable(mediaUrl);

    const r = await sendFreeformMediaViaTrustSignal({
      sender,
      toNumber,
      caption,
      mediaType,
      mediaUrl,
      filename,
    });

    console.log("TS MEDIA RESPONSE =>", safeStringify(r.data));

    ensureTrustSignalAccepted(r.data, "TrustSignal did not accept media send");

    const now = new Date();
    const previewText = caption || previewTextForType(mediaType, filename);

    const created = await WhatsAppMessage.create({
      waId: extractProviderAcceptId(r.data),
      providerTransactionId: extractProviderTransactionId(r.data),
      from: senderForDb(sender),
      to: phone,
      direction: "OUTBOUND",
      type: mediaType,
      text: caption,
      status: "sent",
      timestamp: now,
      media: {
        url: mediaUrl,
        mime: mime || "",
        filename: filename || "attachment",
      },
      raw: r.data,
    });

    await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone,
          lastMessageAt: now,
          lastMessageText: previewText.slice(0, 200),
          lastOutboundAt: now,
        },
      },
      { upsert: true }
    );

    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: now,
        lastMessageText: previewText.slice(0, 200),
        lastOutboundAt: now,
      },
    });

    return res.json({
      success: true,
      mediaUrl,
      providerResponse: r.data || null,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 400;
    const data = e?.data || e?.response?.data || null;

    console.error("Send media error:", { status, data, message: e?.message });

    return res.status(status).json({
      success: false,
      message: "Send media failed",
      providerError: data || { error: e?.message },
    });
  }
});

router.post("/send-template", async (req, res) => {
  try {
    const {
      to,
      templateName,
      templateId: requestedTemplateId = "",
      parameters = [],
      renderedText = "",
      headerMedia = null,
    } = req.body;

    if (!to || (!templateName && !requestedTemplateId)) {
      return res
        .status(400)
        .json({ message: "to & templateName/templateId required" });
    }

    const rawDigits = digitsOnly(to);
    const normalizedTo = rawDigits.length === 10 ? `91${rawDigits}` : rawDigits;
    const phone = normalizeWaId(normalizedTo);
    const p10 = last10(phone);
    const sender = getTrustSignalSenderOrThrow();

    const originalTemplateName = String(templateName || "").trim();
    const cleanTemplateName = normalizeTemplateName(originalTemplateName);
    const requestedId = String(requestedTemplateId || "").trim();

    const or = [];
    if (requestedId) {
      or.push(
        { template_id: requestedId },
        { templateId: requestedId },
        { providerTemplateId: requestedId },
        { provider_template_id: requestedId },
        { externalTemplateId: requestedId }
      );
    }
    if (originalTemplateName) {
      or.push({ name: cleanTemplateName }, { name: originalTemplateName });
    }

    const tpl = await WhatsAppTemplate.findOne({ $or: or }).lean();
    if (!tpl) {
      return res.status(400).json({ message: "Template not found" });
    }

    if (String(tpl.status || "").toUpperCase() !== "APPROVED") {
      return res.status(400).json({ message: "Template not approved" });
    }

    const providerTemplateId = resolveTemplateIdentifier(tpl, requestedId);
    if (!providerTemplateId) {
      return res.status(400).json({
        message: "Full TrustSignal template_id missing in DB",
        code: "TEMPLATE_ID_MISSING",
      });
    }

    const paramValues = asArray(parameters).map((x) => String(x ?? "").trim());
    const normalizedHeaderMedia = normalizeTemplateHeaderMediaInput(headerMedia);

    const payload = buildTrustSignalTemplatePayload({
      sender,
      to: phone,
      providerTemplateId,
      parameters: paramValues,
      headerMedia: normalizedHeaderMedia,
    });

    console.log("TS TEMPLATE PAYLOAD =>", JSON.stringify(payload, null, 2));

    const r = await tsRequest({
      method: "POST",
      path: TS_PATH_SEND_TEMPLATE,
      data: payload,
      headers: { "Content-Type": "application/json" },
    });

    ensureTrustSignalAccepted(r.data, "TrustSignal did not accept template send");

    const now = new Date();

    const clientText = String(renderedText || "").trim();
    const serverBody = extractTemplateBodyText(tpl);
    const serverText = serverBody
      ? applyTemplateVars(serverBody, paramValues)
      : "";
    const finalText =
      clientText || serverText || `[TEMPLATE] ${tpl.name || providerTemplateId}`;

    const messageDoc = {
      waId: extractProviderAcceptId(r.data),
      providerTransactionId: extractProviderTransactionId(r.data),
      from: senderForDb(sender),
      to: phone,
      direction: "OUTBOUND",
      type: "template",
      text: finalText,
      status: "sent",
      templateMeta: {
        name: tpl.name || originalTemplateName,
        templateId: providerTemplateId,
        language: String(tpl.language || "").trim(),
        parameters: paramValues,
        ...(normalizedHeaderMedia
          ? {
            headerMedia: {
              format: String(normalizedHeaderMedia.format || ""),
              id: String(normalizedHeaderMedia.id || ""),
              filename: String(normalizedHeaderMedia.filename || ""),
              ...(normalizedHeaderMedia.url
                ? { url: normalizedHeaderMedia.url }
                : {}),
              ...(normalizedHeaderMedia.mime
                ? { mime: normalizedHeaderMedia.mime }
                : {}),
            },
          }
          : {}),
      },
      timestamp: now,
      raw: r.data,
    };

    if (normalizedHeaderMedia?.url) {
      messageDoc.media = {
        url: normalizedHeaderMedia.url,
        mime: normalizedHeaderMedia.mime || "",
        filename: normalizedHeaderMedia.filename || "attachment",
      };
    }

    const created = await WhatsAppMessage.create(messageDoc);

    await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone,
          lastMessageAt: now,
          lastMessageText: finalText.slice(0, 200),
          lastOutboundAt: now,
        },
      },
      { upsert: true }
    );

    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: now,
        lastMessageText: finalText.slice(0, 200),
        lastOutboundAt: now,
      },
    });

    return res.json({ success: true, providerResponse: r.data || null });
  } catch (e) {
    const status = e?.status || e?.response?.status || 400;
    const data = e?.data || e?.response?.data || null;

    const countryBlocked = findProviderError(
      data,
      (x) =>
        String(x?.code || "") === "1013" ||
        String(x?.codeMsg || "").toUpperCase() ===
        "WHATSAPP_COUNTRY_NOT_ALLOWED"
    );

    if (countryBlocked) {
      return res.status(400).json({
        success: false,
        code: "WHATSAPP_COUNTRY_NOT_ALLOWED",
        message:
          "Send template failed: this TrustSignal sender/account is not enabled to send WhatsApp messages to this destination country.",
        providerError: data,
      });
    }

    console.error("Send template error:", {
      status,
      providerError: data,
      message: e?.message,
    });

    return res.status(status).json({
      success: false,
      message: "Send template failed",
      providerError: data || { error: e?.message || "UNKNOWN_ERROR" },
    });
  }
});

router.get("/webhook", (req, res) => res.sendStatus(200));

router.get("/webhook-debug", async (req, res) => {
  try {
    const phone = last10(req.query.phone || "");
    const filter = phone ? { phone: new RegExp(`${phone}$`) } : {};
    const rows = await WhatsAppWebhookDebug.find(filter)
      .sort({ receivedAt: -1 })
      .limit(50)
      .lean();
    return res.json(rows || []);
  } catch (e) {
    console.error("webhook debug load error:", e);
    return res.status(500).json({ message: "Failed to load webhook debug" });
  }
});

async function recordWebhookDebug(doc = {}) {
  try {
    await WhatsAppWebhookDebug.create({
      webhookType: String(doc.webhookType || ""),
      outcome: String(doc.outcome || ""),
      status: String(doc.status || ""),
      waId: String(doc.waId || ""),
      transactionId: String(doc.transactionId || ""),
      phone: doc.phone ? normalizeWaId(doc.phone) : "",
      matchedMessageId: doc.matchedMessageId ? String(doc.matchedMessageId) : "",
      matchedStatus: String(doc.matchedStatus || ""),
      raw: doc.raw || {},
    });
  } catch (e) {
    console.error("webhook debug write error:", e?.message || e);
  }
}

function buildInboundMessageMatch({
  waId,
  from,
  to,
  timestamp = null,
  type,
  text,
  media,
}) {
  const cleanWaId = String(waId || "").trim();
  if (cleanWaId) return { waId: cleanWaId };

  const match = {
    direction: "INBOUND",
    from,
    to,
    type,
    text,
  };

  if (timestamp) {
    match.timestamp = timestamp;
  }

  const mediaId = String(media?.id || "").trim();
  const mediaFilename = String(media?.filename || "").trim();
  const mediaUrl = String(media?.url || "").trim();

  if (mediaId) match["media.id"] = mediaId;
  if (mediaFilename) match["media.filename"] = mediaFilename;
  if (mediaUrl) match["media.url"] = mediaUrl;

  return match;
}

router.post("/webhook", async (req, res) => {
  try {
    console.log("TS WEBHOOK RAW =>", JSON.stringify(req.body || {}, null, 2));

    const webhookType = String(req.body?.webhook_type || "").trim();

    if (webhookType === "phone_number_quality_update") {
      const value = req.body?.value || {};

      const displayPhoneNumber = String(
        value?.display_phone_number || ""
      ).trim();
      const event = String(value?.event || "").trim();
      const currentLimit = String(value?.current_limit || "").trim();
      const oldLimit = String(value?.old_limit || "").trim();
      const acid = String(req.body?.acid || "").trim();

      const senderInEnv = String(
        process.env.TRUSTSIGNAL_SENDER_ID ||
        process.env.TRUSTSIGNAL_SENDER ||
        ""
      ).trim();

      const displayDigits = digitsOnly(displayPhoneNumber);
      const envDigits = digitsOnly(senderInEnv);

      console.log(
        "TS PHONE QUALITY WEBHOOK =>",
        JSON.stringify(
          {
            webhook_type: "phone_number_quality_update",
            acid,
            display_phone_number: displayPhoneNumber,
            event,
            current_limit: currentLimit,
            old_limit: oldLimit,
            sender_env: senderInEnv,
            sender_matches_env: Boolean(
              displayDigits && envDigits && displayDigits === envDigits
            ),
          },
          null,
          2
        )
      );

      return res.sendStatus(200);
    }

    if (webhookType === "phone_number_name_update") {
      const value = req.body?.value || {};
      console.log(
        "TS PHONE NAME WEBHOOK =>",
        JSON.stringify(
          {
            webhook_type: "phone_number_name_update",
            acid: String(req.body?.acid || "").trim(),
            display_phone_number: String(
              value?.display_phone_number || ""
            ).trim(),
            decision: String(value?.decision || "").trim(),
            requested_verified_name: String(
              value?.requested_verified_name || ""
            ).trim(),
            rejection_reason: String(value?.rejection_reason || "").trim(),
          },
          null,
          2
        )
      );
      return res.sendStatus(200);
    }

    if (webhookType === "embedded") {
      console.log(
        "TS EMBEDDED WEBHOOK =>",
        JSON.stringify(req.body || {}, null, 2)
      );
      return res.sendStatus(200);
    }

    if (webhookType === "message_template_status_update") {
      const value = req.body?.value || {};
      const templateId = String(value?.message_template_id || "").trim();
      const templateName = normalizeTemplateName(
        value?.message_template_name || ""
      );
      const language = String(
        value?.message_template_language || ""
      ).trim();
      const event = normalizeTemplateStatus(value?.event || "");
      const reason = String(value?.reason || "").trim();

      const filter = templateId
        ? {
          $or: [
            { template_id: templateId },
            { templateId: templateId },
            { providerTemplateId: templateId },
            { provider_template_id: templateId },
            { externalTemplateId: templateId },
            ...(templateName ? [{ name: templateName }] : []),
          ],
        }
        : {
          ...(templateName ? { name: templateName } : {}),
          ...(language ? { language } : {}),
        };

      if (Object.keys(filter).length) {
        await WhatsAppTemplate.findOneAndUpdate(
          filter,
          {
            $set: {
              ...(templateName ? { name: templateName } : {}),
              ...(language ? { language } : {}),
              ...(templateId
                ? {
                  template_id: templateId,
                  templateId: templateId,
                  providerTemplateId: templateId,
                }
                : {}),
              ...(event ? { status: event } : {}),
              rejectionReason: reason === "NONE" ? "" : reason,
              raw360: req.body,
            },
          },
          { upsert: true }
        );
      }

      console.log(
        "TS TEMPLATE STATUS WEBHOOK =>",
        JSON.stringify(req.body || {}, null, 2)
      );
      return res.sendStatus(200);
    }

    if (webhookType === "template_category_update") {
      const value = req.body?.value || {};
      const templateId = String(value?.message_template_id || "").trim();
      const templateName = normalizeTemplateName(
        value?.message_template_name || ""
      );
      const language = String(
        value?.message_template_language || ""
      ).trim();
      const newCategory = normalizeTemplateCategory(value?.new_category || "");

      const filter = templateId
        ? {
          $or: [
            { template_id: templateId },
            { templateId: templateId },
            { providerTemplateId: templateId },
            { provider_template_id: templateId },
            { externalTemplateId: templateId },
            ...(templateName ? [{ name: templateName }] : []),
          ],
        }
        : {
          ...(templateName ? { name: templateName } : {}),
          ...(language ? { language } : {}),
        };

      if (Object.keys(filter).length) {
        await WhatsAppTemplate.findOneAndUpdate(
          filter,
          {
            $set: {
              ...(templateName ? { name: templateName } : {}),
              ...(language ? { language } : {}),
              ...(templateId
                ? {
                  template_id: templateId,
                  templateId: templateId,
                  providerTemplateId: templateId,
                }
                : {}),
              ...(newCategory ? { category: newCategory } : {}),
              raw360: req.body,
            },
          },
          { upsert: true }
        );
      }

      console.log(
        "TS TEMPLATE CATEGORY WEBHOOK =>",
        JSON.stringify(req.body || {}, null, 2)
      );
      return res.sendStatus(200);
    }

    if (webhookType === "message_template_quality_update") {
      console.log(
        "TS TEMPLATE QUALITY WEBHOOK =>",
        JSON.stringify(req.body || {}, null, 2)
      );
      return res.sendStatus(200);
    }

    const parsed = parseWebhookPayload(req.body || {});
    if (!(parsed.statuses || []).length && !(parsed.messages || []).length) {
      await recordWebhookDebug({
        webhookType,
        outcome: "ignored_no_status_or_message",
        raw: req.body || {},
      });
    }

    const businessPhone =
      normalizeWaId(parsed.businessPhone || "") ||
      normalizeWaId(
        process.env.WHATSAPP_BUSINESS_PHONE ||
        process.env.TRUSTSIGNAL_SENDER_ID ||
        process.env.TRUSTSIGNAL_SENDER ||
        ""
      );

    for (const st of parsed.statuses || []) {
      const waId = String(st?.waId || "").trim();
      const transactionId = String(st?.transactionId || "").trim();
      const newStatus = normalizeDeliveryStatus(st?.status || "");

      if (!isKnownDeliveryStatus(newStatus)) {
        await recordWebhookDebug({
          webhookType,
          outcome: "ignored_unknown_status",
          status: newStatus,
          waId,
          transactionId,
          phone: st.phone || "",
          raw: st.raw || st,
        });
        continue;
      }

      const match = [];
      if (waId) match.push({ waId });
      if (transactionId) {
        match.push(
          { providerTransactionId: transactionId },
          { waId: transactionId },
          { "raw.message_id": transactionId },
          { "raw.data.message_id": transactionId },
          { "raw.results.message_id": transactionId },
          { "raw.results.0.message_id": transactionId },
          { "raw.transaction_id": transactionId },
          { "raw.results.transaction_id": transactionId },
          { "raw.results.0.transaction_id": transactionId },
          { "raw.data.transaction_id": transactionId },
          { "raw.data.results.message_id": transactionId },
          { "raw.data.results.transaction_id": transactionId },
          { "raw.data.results.0.transaction_id": transactionId },
          { "raw.result.transaction_id": transactionId }
        );
      }
      if (!match.length) {
        console.log("WHATSAPP STATUS SKIPPED: missing id", {
          status: newStatus,
          raw: st.raw || st,
        });
        await recordWebhookDebug({
          webhookType,
          outcome: "skipped_missing_id",
          status: newStatus,
          phone: st.phone || "",
          raw: st.raw || st,
        });
        continue;
      }

      const existing = await WhatsAppMessage.findOne({ $or: match });
      if (!existing) {
        console.log("WHATSAPP STATUS UNMATCHED", {
          waId,
          transactionId,
          status: newStatus,
          phone: st.phone || "",
          raw: st.raw || st,
        });
        await recordWebhookDebug({
          webhookType,
          outcome: "unmatched",
          status: newStatus,
          waId,
          transactionId,
          phone: st.phone || "",
          raw: st.raw || st,
        });
        continue;
      }

      const currentRank = deliveryStatusRank(existing.status);
      const nextRank = deliveryStatusRank(newStatus);
      const shouldUpdate =
        newStatus === "failed" ||
        nextRank >= currentRank;

      if (shouldUpdate) {
        existing.status = newStatus;
        if (transactionId) existing.providerTransactionId = transactionId;
        await existing.save();
      }

      const updated = existing.toObject();
      await recordWebhookDebug({
        webhookType,
        outcome: shouldUpdate ? "updated" : "matched_no_rank_change",
        status: newStatus,
        waId,
        transactionId,
        phone: st.phone || customerPhoneFromMsg(updated) || "",
        matchedMessageId: updated._id,
        matchedStatus: updated.status,
        raw: st.raw || st,
      });

      if (updated) {
        const dir = String(updated.direction || "").toUpperCase();
        const customerPhone = dir === "INBOUND" ? updated.from : updated.to;
        const p10 = last10(st.phone || customerPhone || "");
        const liveId = String(
          updated.waId || transactionId || waId || ""
        ).trim();
        if (p10 && liveId) {
          emitStatus(req, {
            phone10: p10,
            waId: liveId,
            status: updated.status,
            providerTransactionId: updated.providerTransactionId,
          });
        }
      }
    }

    for (const msg of parsed.messages || []) {
      if (!msg?.from) continue;

      const waId = String(msg?.waId || "").trim();
      const from = normalizeWaId(msg.from);
      const to = businessPhone;
      if (from && to && from === to) continue;

      const p10 = last10(from);
      const logicalTimestamp = msg?.timestamp ? new Date(msg.timestamp) : null;
      const now = logicalTimestamp || new Date();
      const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      let type = String(msg?.type || "text").toLowerCase();
      let text = String(msg?.text || "").trim();

      const incomingMedia = {
        id: String(msg?.media?.id || "").trim(),
        url: String(msg?.media?.url || "").trim(),
        mime: String(msg?.media?.mime || "").trim(),
        filename: String(msg?.media?.filename || "").trim(),
      };

      const hasIncomingMedia = hasRealMedia(incomingMedia);

      type = inferMediaType({
        type,
        mime: incomingMedia.mime,
        filename: incomingMedia.filename,
        url: incomingMedia.url,
      });

      let media = null;

      if (hasIncomingMedia && type !== "text") {
        const mediaId = incomingMedia.id || waId || "";
        const finalFilename =
          sanitizeFilename(incomingMedia.filename || "") ||
          `${type}_${p10 || "unknown"}_${mediaId || Date.now()}.${extFromMime(
            incomingMedia.mime || ""
          )}`;

        const mirroredUrl = await maybeMirrorInboundMediaToWasabi({
          url: incomingMedia.url,
          mediaId: incomingMedia.id,
          mime: incomingMedia.mime,
          filename: finalFilename,
          from10: p10,
          msgType: type,
        });

        const finalUrl =
          mirroredUrl ||
          buildInboundMediaProxyUrl({
            url: incomingMedia.url,
            mediaId: incomingMedia.id,
            filename: finalFilename,
            mime: incomingMedia.mime || "",
          });

        console.log("INBOUND MEDIA CHOSEN URL =>", {
          messageId: waId,
          mediaId: incomingMedia.id || "",
          rawUrl: incomingMedia.url || "",
          finalUrl,
        });

        media = {
          id: incomingMedia.id || "",
          url: finalUrl,
          mime: incomingMedia.mime || "",
          filename: finalFilename,
        };

        if (!text) {
          text = previewTextForType(type, finalFilename);
        }
      }

      if (!media) {
        type = "text";
      }

      const textValue = String(text || "").slice(0, 4000);

      const inboundPayload = {
        waId: waId || undefined,
        from,
        to,
        direction: "INBOUND",
        type,
        text: textValue,
        status: "received",
        timestamp: now,
        ...(media ? { media } : {}),
        raw: msg.raw || msg,
      };

      const inboundMatch = buildInboundMessageMatch({
        waId,
        from,
        to,
        timestamp: logicalTimestamp,
        type,
        text: textValue,
        media,
      });

      let writeResult;
      try {
        writeResult = await WhatsAppMessage.updateOne(
          inboundMatch,
          { $setOnInsert: inboundPayload },
          { upsert: true }
        );
      } catch (e) {
        if (e?.code === 11000) {
          console.log("Duplicate inbound message skipped:", waId || inboundMatch);
          continue;
        }
        throw e;
      }

      const insertedId =
        writeResult?.upsertedId?._id ||
        writeResult?.upsertedId ||
        null;

      const wasInserted = Boolean(
        writeResult?.upsertedCount ||
        insertedId
      );

      if (!wasInserted) {
        console.log("Inbound duplicate skipped:", waId || inboundMatch);
        continue;
      }

      const created = insertedId
        ? await WhatsAppMessage.findById(insertedId).lean()
        : await WhatsAppMessage.findOne(inboundMatch).lean();

      if (!created) {
        console.log("Inbound inserted but could not reload message:", waId || inboundMatch);
        continue;
      }

      const updatedConv = await WhatsAppConversation.findOneAndUpdate(
        { phone: new RegExp(`${p10}$`) },
        {
          $set: {
            phone: from,
            lastMessageAt: now,
            lastMessageText: String(textValue || "").slice(0, 200),
            lastInboundAt: now,
            windowExpiresAt: windowExpiry,
          },
          $inc: { unreadCount: 1 },
        },
        { upsert: true, new: true }
      ).lean();

      emitMessage(req, created);

      emitConversationPatch(req, {
        phone10: p10,
        patch: {
          lastMessageAt: updatedConv?.lastMessageAt || now,
          lastMessageText:
            updatedConv?.lastMessageText || String(textValue || "").slice(0, 200),
          lastInboundAt: updatedConv?.lastInboundAt || now,
          windowExpiresAt: updatedConv?.windowExpiresAt || windowExpiry,
          unreadCount: updatedConv?.unreadCount ?? 1,
        },
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e?.data || e);
    return res.sendStatus(200);
  }
});

if (AUTO_REPLY_CAN_SEND) {
  setTimeout(() => {
    runAutoReplyWatchdog().catch((e) =>
      console.error("[WA auto-reply] startup run error:", e?.message || e)
    );
  }, 15000);

  setInterval(() => {
    runAutoReplyWatchdog().catch((e) =>
      console.error("[WA auto-reply] interval run error:", e?.message || e)
    );
  }, AUTO_REPLY_SCAN_INTERVAL_MS);
}

module.exports = router;
