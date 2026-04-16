// routes/whatsappMedia.routes.js
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const AWS = require("aws-sdk");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

/* ----------------------------------------
   TRUSTSIGNAL CONFIG
----------------------------------------- */
const TRUSTSIGNAL_API_BASE = String(
  process.env.TRUSTSIGNAL_API_BASE || "https://wpapi.trustsignal.io"
).replace(/\/+$/, "");

const TRUSTSIGNAL_API_KEY = String(
  process.env.TRUSTSIGNAL_API_KEY || ""
).trim();

const TS_PATH_AGENT_REPLY = "/api/v1/whatsapp/agent-reply";

const trustsignalClient = axios.create({
  baseURL: TRUSTSIGNAL_API_BASE,
  timeout: 60000,
  validateStatus: () => true,
});

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

function safeFilename(name = "file") {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function extFromName(name = "") {
  const n = String(name || "").toLowerCase();
  const m = n.match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1] : "";
}

function inferTypeAndMime({ mimetype = "", originalname = "" }) {
  const mime = String(mimetype || "").toLowerCase().trim();
  const ext = extFromName(originalname);

  const audioExts = ["ogg", "opus", "mp3", "wav", "m4a", "aac", "webm"];
  const videoExts = ["mp4", "mov", "webm", "mkv"];
  const imgExts = ["png", "jpg", "jpeg", "webp", "gif"];

  const isAudio =
    mime.startsWith("audio/") ||
    mime.includes("ogg") ||
    mime.includes("opus") ||
    audioExts.includes(ext);

  const isVideo = mime.startsWith("video/") || videoExts.includes(ext);
  const isImage = mime.startsWith("image/") || imgExts.includes(ext);

  const type = isImage
    ? "image"
    : isVideo
    ? "video"
    : isAudio
    ? "audio"
    : "document";

  let bestMime = mime;

  if (!bestMime || bestMime === "application/octet-stream") {
    if (type === "audio") {
      if (ext === "mp3") bestMime = "audio/mpeg";
      else if (ext === "wav") bestMime = "audio/wav";
      else if (ext === "m4a" || ext === "aac") bestMime = "audio/mp4";
      else bestMime = "audio/ogg";
    } else if (type === "image") {
      if (ext === "png") bestMime = "image/png";
      else if (ext === "webp") bestMime = "image/webp";
      else if (ext === "gif") bestMime = "image/gif";
      else bestMime = "image/jpeg";
    } else if (type === "video") {
      bestMime = "video/mp4";
    } else if (ext === "pdf") {
      bestMime = "application/pdf";
    } else if (ext === "doc") {
      bestMime = "application/msword";
    } else if (ext === "docx") {
      bestMime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (ext === "xls") {
      bestMime = "application/vnd.ms-excel";
    } else if (ext === "xlsx") {
      bestMime =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (ext === "csv") {
      bestMime = "text/csv";
    } else if (ext === "txt") {
      bestMime = "text/plain";
    } else {
      bestMime = "application/octet-stream";
    }
  }

  return { type, mime: bestMime };
}

function previewTextForType(type, filename = "") {
  const t = String(type || "").toLowerCase();
  if (t === "image") return "📷 Photo";
  if (t === "video") return "🎥 Video";
  if (t === "audio") return "🎙️ Audio";
  return filename ? `📎 ${filename}` : "📎 Attachment";
}

function isObjectLike(v) {
  return v !== null && typeof v === "object";
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

async function tsRequest({
  method = "GET",
  path = "",
  params = {},
  data = undefined,
  headers = {},
}) {
  const resp = await trustsignalClient.request({
    method,
    url: path,
    params: buildParams(params),
    data,
    headers: buildHeaders(headers),
  });

  return okOrThrow(resp);
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

/* ----------------------------------------
   WASABI
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

function buildPublicWasabiUrl({ endpoint, bucket, key }) {
  const ep = String(endpoint || "").replace(/\/+$/, "");
  if (!ep || !bucket || !key) return null;

  const encodedKey = encodeURIComponent(key).replace(/%2F/g, "/");
  return `${ep}/${bucket}/${encodedKey}`;
}

async function uploadToWasabi({ buffer, mimetype, originalname }) {
  if (!s3 || !WASABI_BUCKET) {
    const err = new Error("Wasabi S3 not configured");
    err.status = 500;
    throw err;
  }

  const ext = extFromName(originalname);
  const safe = safeFilename(
    originalname ||
      `file.${
        ext || (String(mimetype || "").toLowerCase().includes("ogg") ? "ogg" : "bin")
      }`
  );

  const key = `whatsapp-media/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safe}`;

  const result = await s3
    .upload({
      Bucket: WASABI_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || "application/octet-stream",
      ContentDisposition: "inline",
      CacheControl: "public, max-age=31536000",
      ACL: "public-read",
    })
    .promise();

  const url =
    result?.Location ||
    buildPublicWasabiUrl({
      endpoint: WASABI_ENDPOINT,
      bucket: WASABI_BUCKET,
      key,
    });

  return { url, key };
}

/* ----------------------------------------
   SOCKET HELPERS
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

const emitConversationPatch = (req, { phone10, patch }) => {
  const p10 = last10(phone10);
  if (!p10) return;
  emitToPhone10(req, p10, "wa:conversation", { phone10: p10, patch });
};

/* ----------------------------------------
   TRUSTSIGNAL MEDIA SEND
----------------------------------------- */
function trustSignalMediaType(type = "") {
  const t = String(type || "").toLowerCase();
  if (t === "image") return "image";
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  return "document";
}

async function sendMediaViaTrustSignal({
  sender,
  to,
  type,
  mediaUrl,
  filename,
  caption = "",
}) {
  const mediaType = trustSignalMediaType(type);

  const payload = {
    message_type: "file",
    sender: toE164Plus(sender),
    to: toE164Plus(to),
    reply: {
      message:
        String(caption || "").trim() ||
        previewTextForType(type, filename),
      media_type: mediaType,
      media_file_url: String(mediaUrl || "").trim(),
      ...(filename ? { filename: String(filename) } : {}),
    },
  };

  const r = await tsRequest({
    method: "POST",
    path: TS_PATH_AGENT_REPLY,
    data: payload,
    headers: { "Content-Type": "application/json" },
  });

  return {
    messageId: extractProviderMessageId(r.data),
    raw: r.data,
  };
}

/* ----------------------------------------
   ROUTE
----------------------------------------- */
router.post("/send-media", upload.single("file"), async (req, res) => {
  try {
    const toRaw = req.body.to;
    if (!toRaw) return res.status(400).json({ message: "to required" });
    if (!req.file) return res.status(400).json({ message: "file required" });

    const to = normalizeWaId(toRaw);
    const p10 = last10(to);
    const sender = getTrustSignalSenderOrThrow();

    if (req.file.size > 15 * 1024 * 1024) {
      return res.status(400).json({ message: "Max attachment size is 15MB" });
    }

    const inferred = inferTypeAndMime({
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
    });

    const type = inferred.type;
    const mime =
      req.file.mimetype || inferred.mime || "application/octet-stream";
    const previewText = previewTextForType(type, req.file.originalname);

    // 1) Upload to Wasabi first because TrustSignal agent-reply file API needs a public URL
    const wasabi = await uploadToWasabi({
      buffer: req.file.buffer,
      mimetype: mime,
      originalname: req.file.originalname,
    });

    if (!wasabi?.url) {
      return res.status(500).json({
        message: "Wasabi upload failed (no public url returned)",
      });
    }

    // 2) Send media through TrustSignal agent-reply file API
    const sent = await sendMediaViaTrustSignal({
      sender,
      to,
      type,
      mediaUrl: wasabi.url,
      filename: req.file.originalname || "",
      caption: previewText,
    });

    const now = new Date();

    const created = await WhatsAppMessage.create({
      waId: sent.messageId,
      from: senderForDb(sender),
      to,
      direction: "OUTBOUND",
      type,
      text: previewText,
      status: "sent",
      media: {
        id: "",
        url: wasabi.url,
        mime: mime || "application/octet-stream",
        filename: req.file.originalname || "",
      },
      timestamp: now,
      raw: sent.raw,
    });

    const updatedConv = await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone: to,
          lastMessageAt: now,
          lastMessageText: previewText.slice(0, 200),
          lastOutboundAt: now,
        },
      },
      { upsert: true, new: true }
    ).lean();

    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: updatedConv?.lastMessageAt || now,
        lastMessageText:
          updatedConv?.lastMessageText || previewText.slice(0, 200),
        lastOutboundAt: updatedConv?.lastOutboundAt || now,
      },
    });

    return res.json({
      success: true,
      mediaId: null,
      mediaUrl: wasabi.url,
      type,
    });
  } catch (e) {
    console.error("send-media error:", e?.data || e);
    return res.status(e?.status || 400).json({
      message: "Send media failed",
      providerError: e?.data || null,
      error: e?.message || String(e),
    });
  }
});

router.use((err, req, res, next) => {
  if (err) {
    console.error("multer error:", err);
    return res.status(400).json({
      message: "Upload failed",
      error: err.message,
      code: err.code,
    });
  }
  next();
});

module.exports = router;