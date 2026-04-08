// routes/whatsapp.routes.js
const express = require("express");
const axios = require("axios");
const AWS = require("aws-sdk");
const multer = require("multer");
const FormData = require("form-data");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* ----------------------------------------
   TRUSTSIGNAL CONFIG
----------------------------------------- */
const TRUSTSIGNAL_API_BASE = String(
  process.env.TRUSTSIGNAL_API_BASE || "https://wpapi.trustsignal.io"
).replace(/\/+$/, "");

const TRUSTSIGNAL_API_KEY = String(process.env.TRUSTSIGNAL_API_KEY || "").trim();

const TS_PATH_SEND_TEXT = "/api/v1/whatsapp/single";
const TS_PATH_SEND_TEMPLATE = "/api/v1/whatsapp/single";

/*
  Keep these only if TrustSignal confirms these media endpoints for your account.
*/
const TS_PATH_UPLOAD_MEDIA = "/v1/whatsapp/media";
const TS_PATH_MEDIA_META = "/v1/whatsapp/media/:id";
const TS_PATH_MEDIA_DOWNLOAD = "/v1/whatsapp/media/:id/download";

const trustsignalClient = axios.create({
  baseURL: TRUSTSIGNAL_API_BASE,
  timeout: 60000,
  validateStatus: () => true,
});

/* ----------------------------------------
   STORAGE CONFIG
----------------------------------------- */
const WASABI_ENDPOINT = process.env.WASABI_ENDPOINT;
const WASABI_REGION = process.env.WASABI_REGION || "ap-southeast-1";
const WASABI_BUCKET = process.env.WASABI_BUCKET;

const s3 =
  WASABI_ENDPOINT &&
  process.env.WASABI_ACCESS_KEY_ID &&
  process.env.WASABI_SECRET_ACCESS_KEY &&
  WASABI_BUCKET
    ? new AWS.S3({
        endpoint: new AWS.Endpoint(WASABI_ENDPOINT),
        region: WASABI_REGION,
        accessKeyId: process.env.WASABI_ACCESS_KEY_ID,
        secretAccessKey: process.env.WASABI_SECRET_ACCESS_KEY,
        signatureVersion: "v4",
      })
    : null;

/* ----------------------------------------
   HELPERS
----------------------------------------- */
const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);

const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

const toE164Plus = (v = "") => {
  const d = digitsOnly(v);
  return d ? `+${d}` : "";
};

// TrustSignal support asked to remove "+" from recipient number
function getTrustSignalRecipient(v = "") {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
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

function okOrThrow(resp, fallbackMessage = "Provider request failed") {
  if (resp.status >= 200 && resp.status < 300) return resp;

  const message =
    deepPick(resp.data, ["message", "error.message", "error", "details", "result.message"]) ||
    (typeof resp.data === "string" ? resp.data : "") ||
    `${fallbackMessage} (${resp.status})`;

  const err = new Error(String(message));
  err.status = resp.status;
  err.data = resp.data;
  throw err;
}

function isHtmlLikeResponse(data, headers = {}) {
  const ct = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

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

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function findProviderError(data, matcher) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return errors.find((err) => matcher(err)) || null;
}

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
    err.data = typeof resp.data === "string" ? resp.data.slice(0, 1000) : resp.data;
    throw err;
  }

  return resp;
}

function extractProviderMessageId(data) {
  return (
    deepPick(data, [
      "message_id",
      "data.message_id",
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

function extractProviderMediaUrl(data) {
  return (
    deepPick(data, [
      "url",
      "data.url",
      "media.url",
      "result.url",
      "download_url",
      "data.download_url",
      "result.download_url",
      "file.url",
    ]) || null
  );
}

function getTrustSignalSenderOrThrow() {
  const sender = String(
    process.env.TRUSTSIGNAL_SENDER_ID || process.env.TRUSTSIGNAL_SENDER || ""
  ).trim();

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
  if (typeof tpl?.bodyText === "string" && tpl.bodyText.trim()) return tpl.bodyText;
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

const emitStatus = (req, { phone10, waId, status }) => {
  if (!waId) return;
  const p10 = last10(phone10);
  if (!p10) return;
  emitToPhone10(req, p10, "wa:status", { phone10: p10, waId, status });
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
  const t = convo?.lastInboundAt ? new Date(convo.lastInboundAt).getTime() : 0;
  if (!t) return null;
  return new Date(t + 24 * 60 * 60 * 1000);
}

/* ----------------------------------------
   TRUSTSIGNAL MEDIA HELPERS
----------------------------------------- */
async function fetchMediaMeta(mediaId) {
  const id = String(mediaId || "").trim();
  if (!id) throw new Error("mediaId missing");

  const r = await tsRequest({
    method: "GET",
    path: TS_PATH_MEDIA_META,
    pathParams: { id },
  });

  return {
    id,
    downloadUrl: String(extractProviderMediaUrl(r.data) || "").trim(),
    mime_type: String(
      deepPick(r.data, ["mime_type", "mime", "data.mime", "media.mime"]) || ""
    ).trim(),
    raw: r.data || null,
  };
}

async function downloadTrustSignalAttachment({
  mediaId,
  downloadUrl = "",
  range = "",
  asStream = false,
}) {
  const id = String(mediaId || "").trim();
  const directUrl = String(downloadUrl || "").trim();
  const responseType = asStream ? "stream" : "arraybuffer";

  if (directUrl) {
    const r = await axios.request({
      method: "GET",
      url: directUrl,
      params: buildParams(),
      headers: buildHeaders(range ? { Range: range } : {}),
      timeout: 60000,
      responseType,
      validateStatus: () => true,
    });

    if (r.status >= 400) {
      const e = new Error(`download failed: ${r.status}`);
      e.status = r.status;
      e.provider = r.data;
      throw e;
    }

    return r;
  }

  if (!id) throw new Error("mediaId missing");

  const r = await tsRequest({
    method: "GET",
    path: TS_PATH_MEDIA_DOWNLOAD,
    pathParams: { id },
    headers: range ? { Range: range } : {},
    responseType,
  });

  return r;
}

function extFromMime(mime = "") {
  const m = String(mime || "").toLowerCase();

  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("pdf")) return "pdf";

  if (m.includes("audio/ogg") || m.includes("application/ogg") || m.includes("ogg"))
    return "ogg";
  if (m.includes("opus")) return "ogg";
  if (m.includes("audio/mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("m4a") || m.includes("mp4a") || m.includes("aac")) return "m4a";

  return "bin";
}

async function uploadInboundToWasabi({
  buffer,
  mime,
  filename,
  from10,
  mediaId,
  msgType,
}) {
  if (!s3 || !WASABI_BUCKET) return null;

  const day = new Date().toISOString().slice(0, 10);
  const ext = extFromMime(mime);
  const safeName = filename
    ? String(filename).replace(/[^\w.\-() ]+/g, "_")
    : "";
  const base =
    safeName ||
    `${msgType || "media"}_${from10 || "unknown"}_${mediaId || Date.now()}.${ext}`;

  const key = `whatsapp-inbound/${day}/${base}`;

  const up = await s3
    .upload({
      Bucket: WASABI_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime || "application/octet-stream",
      ContentDisposition: "inline",
      CacheControl: "public, max-age=31536000",
      ACL: "public-read",
    })
    .promise();

  const loc = up?.Location || "";
  if (loc) return loc;

  const ep = String(WASABI_ENDPOINT || "").replace(/\/+$/, "");
  if (!ep) return null;

  return `${ep}/${WASABI_BUCKET}/${key}`;
}

const proxyUrlForMediaId = (mediaId) =>
  `/api/whatsapp/media-proxy/${encodeURIComponent(String(mediaId || "").trim())}`;

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
  const type = String(
    deepPick(msg, ["type", "message_type", "content.type", "payload.type"]) || "text"
  ).toLowerCase();

  const node =
    deepPick(msg, [
      `${type}`,
      "media",
      "content.media",
      "payload.media",
      "document",
      "image",
      "audio",
      "video",
    ]) || {};

  return {
    id: String(
      deepPick(node, ["id", "media_id"]) ||
        deepPick(msg, ["media_id", "id"]) ||
        ""
    ).trim(),
    url: String(
      deepPick(node, ["url", "download_url"]) ||
        item?.__fileurl ||
        ""
    ).trim(),
    mime: String(deepPick(node, ["mime_type", "mime", "content_type"]) || "").trim(),
    filename: String(deepPick(node, ["filename", "file_name", "name"]) || "").trim(),
    type,
  };
}

function parseWebhookPayload(body = {}) {
  const buckets = [];
  const topWebhookType = String(body?.webhook_type || "").trim();
  const topFileUrl = String(body?.fileurl || "").trim();
  const topAcid = String(body?.acid || "").trim();

  if (Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        buckets.push({
          ...(change?.value || {}),
          __webhook_type: change?.webhook_type || topWebhookType || "",
          __fileurl: topFileUrl || "",
          __acid: topAcid || "",
        });
      }
    }
  } else if (Array.isArray(body?.events)) {
    for (const ev of body.events) {
      buckets.push({
        ...(ev || {}),
        __webhook_type: ev?.webhook_type || topWebhookType || "",
        __fileurl: ev?.fileurl || topFileUrl || "",
        __acid: ev?.acid || topAcid || "",
      });
    }
  } else if (body?.value && isObjectLike(body.value)) {
    buckets.push({
      ...(body.value || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
    });
  } else if (body?.data || body?.messages || body?.statuses) {
    buckets.push({
      ...(body.data || body),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
    });
  } else {
    buckets.push({
      ...(body || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
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

    const statuses = asArray(item?.statuses || item?.status_updates || item?.status || []);
    for (const st of statuses) {
      const waId = String(deepPick(st, ["id", "wa_id", "message_id"]) || "").trim();
      const status = String(
        deepPick(st, ["status", "state", "event"]) || ""
      ).toLowerCase().trim();
      const phone = normalizeWaId(
        deepPick(st, ["recipient_id", "to", "phone", "customer_phone"]) || ""
      );

      if (waId && status) {
        out.statuses.push({
          waId,
          status,
          phone,
          errors: Array.isArray(st?.errors) ? st.errors : [],
          raw: st,
        });
      }
    }

    const messages = asArray(item?.messages || item?.message || item?.inbound_messages || []);
    for (const msg of messages) {
      const waId = String(deepPick(msg, ["id", "wa_id", "message_id"]) || "").trim();
      const from = normalizeWaId(
        deepPick(msg, ["from", "customer.phone", "sender"]) ||
          deepPick(item, ["contacts.0.wa_id"]) ||
          ""
      );
      const timestampRaw = deepPick(msg, ["timestamp", "time", "created_at"]);
      const timestamp = timestampRaw
        ? new Date(Number(timestampRaw) ? Number(timestampRaw) * 1000 : timestampRaw)
        : new Date();

      const text = textFromInboundMessage(msg);
      const media = mediaFromInboundMessage(msg, item);
      const type = String(
        deepPick(msg, ["type", "message_type", "content.type"]) || media.type || "text"
      ).toLowerCase();

      out.messages.push({
        waId,
        from,
        to: businessPhone || out.businessPhone || "",
        text,
        type,
        media: {
          id: media.id || "", 
          url: media.url || "",
          mime: media.mime || "",
          filename: media.filename || "",
        },
        raw: msg,
        timestamp,
      });
    }
  }

  return out;
}

function parseWebhookPayload(body = {}) {
  const buckets = [];
  const topWebhookType = String(body?.webhook_type || "").trim();
  const topFileUrl = String(body?.fileurl || "").trim();
  const topAcid = String(body?.acid || "").trim();

  if (Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        buckets.push({
          ...(change?.value || {}),
          __webhook_type: change?.webhook_type || topWebhookType || "",
          __fileurl: topFileUrl || "",
          __acid: topAcid || "",
        });
      }
    }
  } else if (Array.isArray(body?.events)) {
    for (const ev of body.events) {
      buckets.push({
        ...(ev || {}),
        __webhook_type: ev?.webhook_type || topWebhookType || "",
        __fileurl: ev?.fileurl || topFileUrl || "",
        __acid: ev?.acid || topAcid || "",
      });
    }
  } else if (body?.value && isObjectLike(body.value)) {
    buckets.push({
      ...(body.value || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
    });
  } else if (body?.data || body?.messages || body?.statuses) {
    buckets.push({
      ...(body.data || body),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
    });
  } else {
    buckets.push({
      ...(body || {}),
      __webhook_type: topWebhookType || "",
      __fileurl: topFileUrl || "",
      __acid: topAcid || "",
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

    const statuses = asArray(item?.statuses || item?.status_updates || item?.status || []);
    for (const st of statuses) {
      const waId = String(deepPick(st, ["id", "wa_id", "message_id"]) || "").trim();
      const status = String(
        deepPick(st, ["status", "state", "event"]) || ""
      ).toLowerCase().trim();
      const phone = normalizeWaId(
        deepPick(st, ["recipient_id", "to", "phone", "customer_phone"]) || ""
      );

      if (waId && status) {
        out.statuses.push({
          waId,
          status,
          phone,
          errors: Array.isArray(st?.errors) ? st.errors : [],
          raw: st,
        });
      }
    }

    const messages = asArray(item?.messages || item?.message || item?.inbound_messages || []);
    for (const msg of messages) {
      const waId = String(deepPick(msg, ["id", "wa_id", "message_id"]) || "").trim();
      const from = normalizeWaId(
        deepPick(msg, ["from", "customer.phone", "sender"]) ||
          deepPick(item, ["contacts.0.wa_id"]) ||
          ""
      );
      const timestampRaw = deepPick(msg, ["timestamp", "time", "created_at"]);
      const timestamp = timestampRaw
        ? new Date(Number(timestampRaw) ? Number(timestampRaw) * 1000 : timestampRaw)
        : new Date();

      const text = textFromInboundMessage(msg);
      const media = mediaFromInboundMessage(msg, item);
      const type = String(
        deepPick(msg, ["type", "message_type", "content.type"]) || media.type || "text"
      ).toLowerCase();

      out.messages.push({
        waId,
        from,
        to: businessPhone || out.businessPhone || "",
        text,
        type,
        media: {
          id: media.id || "",
          url: media.url || "",
          mime: media.mime || "",
          filename: media.filename || "",
        },
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
router.post("/upload-template-media", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "file required" });

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
    console.error("upload-template-media error:", e?.response?.data || e?.data || e);
    return res.status(e?.response?.status || e?.status || 400).json({
      message: e?.message || "Upload template media failed",
      providerError: e?.response?.data || e?.data || null,
    });
  }
});

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
    const { role, userName } = req.query;

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
    leads.forEach((l) => (leadMap[last10(l.contactNumber)] = l));

    const customerMap = {};
    customers.forEach((c) => (customerMap[last10(c.phone)] = c));

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
    const isAdmin =
      ["Manager", "Developer", "Super Admin", "Admin"].includes(r) ||
      r.toLowerCase().includes("admin") ||
      r.toLowerCase().includes("manager");

    if (!isAdmin) {
      const u = String(userName || "").toLowerCase();
      enriched = enriched.filter(
        (chat) => String(chat.assignedToLabel || "").toLowerCase() === u
      );
    }

    res.json(enriched);
  } catch (e) {
    console.error("Conversation load error:", e);
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const q = digitsOnly(req.query.phone);
    if (!q) return res.status(400).json({ message: "phone required" });

    const waId = normalizeWaId(q);
    const l10 = waId.slice(-10);

    const msgs = await WhatsAppMessage.find({
      $or: [
        { from: waId },
        { to: waId },
        { from: new RegExp(`${l10}$`) },
        { to: new RegExp(`${l10}$`) },
      ],
    })
      .sort({ timestamp: 1 })
      .lean();

    res.json(msgs || []);
  } catch (e) {
    console.error("load messages error:", e);
    res.status(500).json({ message: "Failed to load messages" });
  }
});

router.get("/templates", async (req, res) => {
  try {
    const tpls = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();
    res.json(tpls || []);
  } catch (e) {
    console.error("load templates error:", e);
    res.status(500).json({ message: "Failed to load templates" });
  }
});

router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !String(text || "").trim()) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const convo = await WhatsAppConversation.findOne({
      phone: new RegExp(`${p10}$`),
    }).lean();

    const expiry = freeformExpiryFromConvo(convo) || convo?.windowExpiresAt || null;

    if (!expiry || expiry < new Date()) {
      return res.status(400).json({
        message: "Session expired. Use template message.",
        code: "SESSION_EXPIRED",
      });
    }

    const sender = getTrustSignalSenderOrThrow();
    const toNumber = getTrustSignalRecipient(phone);

    const payload = {
      message_type: "text",
      sender,
      to: toNumber,
      message: String(text).trim(),
    };

    const r = await tsRequest({
      method: "POST",
      path: TS_PATH_SEND_TEXT,
      data: payload,
      headers: { "Content-Type": "application/json" },
    });

    const now = new Date();

    const created = await WhatsAppMessage.create({
      waId: extractProviderMessageId(r.data),
      from: senderForDb(sender),
      to: phone,
      text: String(text).trim(),
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
          lastMessageText: String(text).trim().slice(0, 200),
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
        lastMessageText: String(text).trim().slice(0, 200),
        lastOutboundAt: now,
      },
    });

    return res.json({ success: true, providerResponse: r.data || null });
  } catch (e) {
    const status = e?.response?.status || e?.status || 400;
    const data = e?.response?.data || e?.data || null;

    const countryBlocked = findProviderError(
      data,
      (x) =>
        String(x?.code || "") === "1013" ||
        String(x?.codeMsg || "").toUpperCase() === "WHATSAPP_COUNTRY_NOT_ALLOWED"
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

    console.error("Send text error:", {
      status,
      data,
      message: e?.message,
    });

    return res.status(status).json({
      success: false,
      message: "Send text failed",
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
      return res.status(400).json({ message: "to & templateName/templateId required" });
    }

    const rawDigits = digitsOnly(to);
    const normalizedTo = rawDigits.length === 10 ? `91${rawDigits}` : rawDigits;
    const phone = normalizeWaId(normalizedTo);
    const p10 = last10(phone);
    const toNumber = getTrustSignalRecipient(phone);
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

    const payload = {
      message_type: "text",
      sender,
      to: toNumber,
      template_id: providerTemplateId,
    };

    console.log("TS TEMPLATE PAYLOAD =>", JSON.stringify(payload, null, 2));

    const r = await tsRequest({
      method: "POST",
      path: TS_PATH_SEND_TEMPLATE,
      data: payload,
      headers: { "Content-Type": "application/json" },
    });

    const now = new Date();

    const clientText = String(renderedText || "").trim();
    const serverBody = extractTemplateBodyText(tpl);
    const serverText = serverBody ? applyTemplateVars(serverBody, asArray(parameters)) : "";
    const finalText = clientText || serverText || `[TEMPLATE] ${tpl.name || providerTemplateId}`;

    const created = await WhatsAppMessage.create({
      waId: extractProviderMessageId(r.data),
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
        parameters: asArray(parameters).map((x) => String(x ?? "")),
        ...(headerMedia?.id
          ? {
              headerMedia: {
                format: String(headerMedia.format || ""),
                id: String(headerMedia.id),
                filename: String(headerMedia.filename || ""),
              },
            }
          : {}),
      },
      timestamp: now,
      raw: r.data,
    });

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
    const status = e?.response?.status || e?.status || 400;
    const data = e?.response?.data || e?.data || null;

    const countryBlocked = findProviderError(
      data,
      (x) =>
        String(x?.code || "") === "1013" ||
        String(x?.codeMsg || "").toUpperCase() === "WHATSAPP_COUNTRY_NOT_ALLOWED"
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

router.get("/media-proxy/:id", async (req, res) => {
  const mediaId = String(req.params.id || "").trim();
  if (!mediaId) return res.status(400).send("mediaId required");

  try {
    let meta = null;
    try {
      meta = await fetchMediaMeta(mediaId);
    } catch {
      meta = null;
    }

    const range = req.headers.range || "";

    const r = await downloadTrustSignalAttachment({
      mediaId,
      downloadUrl: meta?.downloadUrl || "",
      range,
      asStream: true,
    });

    res.status(r.status);

    const ct =
      r.headers["content-type"] ||
      meta?.mime_type ||
      "application/octet-stream";
    res.setHeader("Content-Type", ct);

    res.setHeader("Accept-Ranges", r.headers["accept-ranges"] || "bytes");
    if (range && r.headers["content-range"]) {
      res.setHeader("Content-Range", r.headers["content-range"]);
    }
    if (r.headers["content-length"]) {
      res.setHeader("Content-Length", r.headers["content-length"]);
    }

    res.setHeader("Cache-Control", "no-store");
    r.data.pipe(res);
  } catch (e) {
    console.error("media-proxy error:", {
      code: e.code,
      message: e.message,
      status: e?.status,
      data: e?.data,
    });

    return res.status(e?.status || 500).json({
      message: "proxy failed",
      error: e.message,
      status: e?.status || null,
      providerError: e?.data || null,
    });
  }
});

router.get("/webhook", (req, res) => res.sendStatus(200));

router.post("/webhook", async (req, res) => {
  try {
    const webhookType = String(req.body?.webhook_type || "").trim();

    if (webhookType === "phone_number_quality_update") {
      const value = req.body?.value || {};

      const displayPhoneNumber = String(value?.display_phone_number || "").trim();
      const event = String(value?.event || "").trim();
      const currentLimit = String(value?.current_limit || "").trim();
      const oldLimit = String(value?.old_limit || "").trim();
      const acid = String(req.body?.acid || "").trim();

      const senderInEnv = String(
        process.env.TRUSTSIGNAL_SENDER_ID || process.env.TRUSTSIGNAL_SENDER || ""
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
            sender_matches_env: Boolean(displayDigits && envDigits && displayDigits === envDigits),
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
            display_phone_number: String(value?.display_phone_number || "").trim(),
            decision: String(value?.decision || "").trim(),
            requested_verified_name: String(value?.requested_verified_name || "").trim(),
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
      const templateName = normalizeTemplateName(value?.message_template_name || "");
      const language = String(value?.message_template_language || "").trim();
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
      const templateName = normalizeTemplateName(value?.message_template_name || "");
      const language = String(value?.message_template_language || "").trim();
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
    const businessPhone =
      normalizeWaId(parsed.businessPhone || "") ||
      normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || "");

    for (const st of parsed.statuses || []) {
      const waId = st?.waId;
      if (!waId) continue;

      const newStatus = String(st.status || "").toLowerCase().trim();
      if (!newStatus) continue;

      const updated = await WhatsAppMessage.findOneAndUpdate(
        { waId },
        { $set: { status: newStatus } },
        { new: true }
      ).lean();

      if (updated) {
        const dir = String(updated.direction || "").toUpperCase();
        const customerPhone = dir === "INBOUND" ? updated.from : updated.to;
        const p10 = last10(st.phone || customerPhone || "");
        if (p10) emitStatus(req, { phone10: p10, waId, status: newStatus });
      }
    }

    for (const msg of parsed.messages || []) {
      if (!msg?.from) continue;

      const waId = String(msg?.waId || "").trim();

      if (waId) {
        const already = await WhatsAppMessage.findOne({ waId }).select("_id").lean();
        if (already) continue;
      }

      const from = normalizeWaId(msg.from);
      const to = businessPhone;
      if (from && to && from === to) continue;

      const p10 = last10(from);
      const now = msg?.timestamp ? new Date(msg.timestamp) : new Date();
      const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      let type = String(msg?.type || "text").toLowerCase();
      let text = String(msg?.text || "").trim();
      const mediaId = String(msg?.media?.id || "").trim();

      let media = null;

      if (mediaId) {
        if (!["image", "video", "audio", "document"].includes(type)) {
          type = "document";
        }

        try {
          const meta = await fetchMediaMeta(mediaId);

          const mimeFromMeta = String(meta?.mime_type || "").trim();
          const mimeFromWebhook = String(msg?.media?.mime || "").trim();
          const baseMime =
            (mimeFromMeta || mimeFromWebhook || "application/octet-stream").trim() ||
            "application/octet-stream";

          const filename =
            String(msg?.media?.filename || "").trim() ||
            `${type}_${p10 || "unknown"}_${mediaId}.${extFromMime(baseMime)}`;

          media = {
            id: mediaId,
            url: msg?.media?.url || proxyUrlForMediaId(mediaId),
            mime: baseMime,
            filename,
          };

          try {
            const dl = await downloadTrustSignalAttachment({
              mediaId,
              downloadUrl: meta?.downloadUrl || msg?.media?.url || "",
              asStream: false,
            });

            const buffer = Buffer.isBuffer(dl.data) ? dl.data : Buffer.from(dl.data);
            const bestMime =
              String(dl.headers?.["content-type"] || baseMime || "").trim() ||
              "application/octet-stream";

            const wasabiUrl = await uploadInboundToWasabi({
              buffer,
              mime: bestMime,
              filename,
              from10: p10,
              mediaId,
              msgType: type,
            });

            media = {
              id: mediaId,
              url: wasabiUrl || msg?.media?.url || proxyUrlForMediaId(mediaId),
              mime: bestMime,
              filename,
            };
          } catch (uploadErr) {
            console.error(
              "Inbound Wasabi upload failed (keeping proxy url):",
              uploadErr?.data || uploadErr
            );
          }

          if (!text) {
            text =
              type === "image"
                ? "📷 Photo"
                : type === "video"
                ? "🎥 Video"
                : type === "audio"
                ? "🎙️ Audio"
                : "📎 Attachment";
          }
        } catch (e) {
          console.error("Inbound media handling failed:", e?.data || e);

          if (!text) {
            text =
              type === "image"
                ? "📷 Photo"
                : type === "video"
                ? "🎥 Video"
                : type === "audio"
                ? "🎙️ Audio"
                : "📎 Attachment";
          }

          if (!media) {
            media = {
              id: mediaId,
              url: msg?.media?.url || proxyUrlForMediaId(mediaId),
              mime: String(msg?.media?.mime || "").trim() || "",
              filename: String(msg?.media?.filename || "").trim() || "",
            };
          }
        }
      }

      const created = await WhatsAppMessage.create({
        waId: waId || undefined,
        from,
        to,
        direction: "INBOUND",
        type,
        text: String(text || "").slice(0, 4000),
        status: "received",
        timestamp: now,
        media: media || undefined,
        raw: msg.raw || msg,
      });

      const updatedConv = await WhatsAppConversation.findOneAndUpdate(
        { phone: new RegExp(`${p10}$`) },
        {
          $set: {
            phone: from,
            lastMessageAt: now,
            lastMessageText: String(text || "").slice(0, 200),
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
            updatedConv?.lastMessageText || String(text || "").slice(0, 200),
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

module.exports = router;