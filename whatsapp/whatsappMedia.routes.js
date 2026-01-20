// routes/whatsappMedia.routes.js
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const AWS = require("aws-sdk");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // ✅ 5MB
});

// ----------------------
// Helpers
// ----------------------
const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);

const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

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
    mime.startsWith("audio/") || mime.includes("ogg") || mime.includes("opus") || audioExts.includes(ext);
  const isVideo = mime.startsWith("video/") || videoExts.includes(ext);
  const isImage = mime.startsWith("image/") || imgExts.includes(ext);

  const type = isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "document";

  // ✅ best guess mime if multer gives octet-stream
  let bestMime = mime;
  if (!bestMime || bestMime === "application/octet-stream") {
    if (type === "audio") {
      if (ext === "mp3") bestMime = "audio/mpeg";
      else if (ext === "wav") bestMime = "audio/wav";
      else if (ext === "m4a" || ext === "aac") bestMime = "audio/mp4";
      else bestMime = "audio/ogg"; // WhatsApp voice note default
    } else if (type === "image") {
      bestMime = ext === "png" ? "image/png" : "image/jpeg";
    } else if (type === "video") {
      bestMime = "video/mp4";
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

// NOTE: WhatsApp "voice note" is determined by codec/container (ogg/opus).
// Do NOT send `voice: true` in payload; many providers ignore or reject it.

// ----------------------
// WASABI S3 CONFIG (unified env names with other files)
// ----------------------
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

  // encode but keep slashes
  const encodedKey = encodeURIComponent(key).replace(/%2F/g, "/");
  return `${ep}/${bucket}/${encodedKey}`;
}

// ----------------------
// 360dialog client (reuse same base logic as whatsapp.routes.js if you want)
// ----------------------
function normalizeMessagingBaseUrl(raw = "") {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  u = u.replace(/\/v1$/i, "");
  return u;
}

const WHATSAPP_MSG_BASE =
  normalizeMessagingBaseUrl(process.env.WHATSAPP_BASE_URL) ||
  "https://waba-v2.360dialog.io";

const whatsappClient = axios.create({
  baseURL: WHATSAPP_MSG_BASE, // ✅ NO /v1 here
  headers: {
    "D360-API-KEY": process.env.WHATSAPP_API_KEY,
  },
  timeout: 20000,
});

// ================================
// Socket emit helpers (rooms: wa:<last10>)
// ================================
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

// ----------------------
// Wasabi upload
// ----------------------
async function uploadToWasabi({ buffer, mimetype, originalname }) {
  if (!s3 || !WASABI_BUCKET) throw new Error("Wasabi S3 not configured");

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
      ContentDisposition: "inline", // ✅ helps playback in browser
      CacheControl: "public, max-age=31536000",
      ACL: "public-read",
    })
    .promise();

  // Wasabi sometimes returns empty/undefined Location; build URL fallback
  const url =
    result?.Location ||
    buildPublicWasabiUrl({ endpoint: WASABI_ENDPOINT, bucket: WASABI_BUCKET, key });

  return { url, key };
}

/**
 * POST /api/whatsapp/send-media
 * form-data: to, file
 */
router.post("/send-media", upload.single("file"), async (req, res) => {
  try {
    const toRaw = req.body.to;
    if (!toRaw) return res.status(400).json({ message: "to required" });
    if (!req.file) return res.status(400).json({ message: "file required" });

    const to = normalizeWaId(toRaw);
    const p10 = last10(to);

    // multer already enforces 5MB, but keep this for safety
    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "Max attachment size is 5MB" });
    }

    // ✅ Decide type reliably (mime + extension)
    const inferred = inferTypeAndMime({
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
    });

    const type = inferred.type;
    // prefer the real mimetype (NOT lower-cased) for upload headers
    const mime = req.file.mimetype || inferred.mime || "application/octet-stream";
    const previewText = previewTextForType(type, req.file.originalname);

    // 1) Upload to Wasabi (store URL in DB)
    const wasabi = await uploadToWasabi({
      buffer: req.file.buffer,
      mimetype: mime,
      originalname: req.file.originalname,
    });

    if (!wasabi?.url) {
      return res.status(500).json({
        message: "Wasabi upload failed (no url returned)",
      });
    }

    // 2) Upload media to 360dialog to get mediaId (required to send)
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname || "file",
      contentType: mime,
      knownLength: req.file.size,
    });

    const uploadRes = await whatsappClient.post("/media", fd, {
      headers: { ...fd.getHeaders(), "D360-API-KEY": process.env.WHATSAPP_API_KEY },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const mediaId = uploadRes.data?.id;
    if (!mediaId) {
      return res.status(400).json({
        message: "360dialog media upload failed",
        provider: uploadRes.data,
      });
    }

    // 3) Send message with media id
    // NOTE: Do NOT include `voice: true`. Voice note is determined by codec/container.
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type,
      [type]: {
        id: mediaId,
        ...(type === "document" ? { filename: req.file.originalname } : {}),
      },
    };

    const msgRes = await whatsappClient.post("/messages", payload, {
      headers: { "Content-Type": "application/json" },
    });

    const now = new Date();

    // 4) Save in DB with Wasabi URL (and correct type/mime + friendly text)
    const created = await WhatsAppMessage.create({
      waId: msgRes.data?.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to,
      direction: "OUTBOUND",
      type, // ✅ audio/video/image/document
      text: previewText, // ✅ so UI shows 🎙️ Audio etc.
      status: "sent",
      media: {
        id: mediaId,
        url: wasabi.url,
        mime: mime || "application/octet-stream",
        filename: req.file.originalname || "",
      },
      timestamp: now,
      raw: msgRes.data,
    });

    // ✅ Update conversation preview with correct label
    // Use last10 regex so it matches conversations stored as 91xxxxxxxxxx
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

    // ✅ realtime emits
    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: updatedConv?.lastMessageAt || now,
        lastMessageText: updatedConv?.lastMessageText || previewText.slice(0, 200),
        lastOutboundAt: updatedConv?.lastOutboundAt || now,
      },
    });

    return res.json({ success: true, mediaId, mediaUrl: wasabi.url, type });
  } catch (e) {
    console.error("send-media error:", e.response?.data || e);
    return res.status(e.response?.status || 400).json({
      message: "Send media failed",
      providerError: e.response?.data || null,
      error: e?.message || String(e),
    });
  }
});
 

router.get("/media-proxy/:id", async (req, res) => {
  try {
    const mediaId = String(req.params.id || "").trim();
    if (!mediaId) return res.status(400).send("mediaId required");

    let info;
    try { info = await whatsappClient.get(`/media/${mediaId}`); }
    catch { info = await whatsappClient.get(`/v1/media/${mediaId}`); }

    const providerUrl = String(info?.data?.url || "").trim();
    if (!providerUrl) return res.status(404).send("provider url missing");

    const range = req.headers.range;

    const r = await axios.get(providerUrl, {
      responseType: "stream",
      timeout: 30000,
      headers: {
        "D360-API-KEY": process.env.WHATSAPP_API_KEY,
        ...(range ? { Range: range } : {}),
      },
      validateStatus: () => true,
    });

    // Forward status (206 for partial content)
    res.status(r.status);

    // Forward key headers
    const ct = r.headers["content-type"] || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    if (r.headers["content-length"]) res.setHeader("Content-Length", r.headers["content-length"]);
    if (r.headers["content-range"]) res.setHeader("Content-Range", r.headers["content-range"]);
    if (r.headers["accept-ranges"]) res.setHeader("Accept-Ranges", r.headers["accept-ranges"]);
    else res.setHeader("Accept-Ranges", "bytes");

    res.setHeader("Cache-Control", "no-store");

    r.data.pipe(res);
  } catch (e) {
    console.error("media-proxy error:", e.response?.data || e);
    return res.status(500).send("proxy failed");
  }
});

// multer error handler
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
