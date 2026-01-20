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
    mime.startsWith("audio/") || mime.includes("ogg") || audioExts.includes(ext);

  const isVideo = mime.startsWith("video/") || videoExts.includes(ext);

  const isImage = mime.startsWith("image/") || imgExts.includes(ext);

  const type = isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "document";
  return { type, mime: mime || "" };
}

function previewTextForType(type, filename = "") {
  const t = String(type || "").toLowerCase();
  if (t === "image") return "📷 Photo";
  if (t === "video") return "🎥 Video";
  if (t === "audio") return "🎙️ Audio";
  return filename ? `📎 ${filename}` : "📎 Attachment";
}

function shouldSendAsVoiceNote(type, mime, filename) {
  if (String(type) !== "audio") return false;
  const m = String(mime || "").toLowerCase();
  const ext = extFromName(filename || "");
  // ✅ WhatsApp "voice notes" are audio/ogg (opus)
  return m.includes("audio/ogg") || ext === "ogg" || ext === "opus";
}

// ----------------------
// WASABI S3 CONFIG
// ----------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});

// ----------------------
// 360dialog client
// ----------------------
const whatsappClient = axios.create({
  baseURL: "https://waba-v2.360dialog.io",
  headers: { "D360-API-KEY": process.env.WHATSAPP_API_KEY },
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

const emitMessage = (req, msgDoc) => {
  if (!msgDoc) return;
  const customerPhone = msgDoc?.direction === "INBOUND" ? msgDoc?.from : msgDoc?.to;
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
  const bucket = process.env.WASABI_BUCKET;
  if (!bucket) throw new Error("WASABI_BUCKET missing");

  const ext = extFromName(originalname);
  const safe = safeFilename(
    originalname || `file.${ext || (String(mimetype || "").includes("ogg") ? "ogg" : "bin")}`
  );

  const key = `whatsapp-media/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safe}`;

  const result = await s3
    .upload({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimetype || "application/octet-stream",
      ACL: "public-read",
    })
    .promise();

  return { url: result.Location, key };
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
    const mime = inferred.mime || req.file.mimetype || "";
    const previewText = previewTextForType(type, req.file.originalname);

    // 1) Upload to Wasabi (store URL in DB)
    const wasabi = await uploadToWasabi({
      buffer: req.file.buffer,
      mimetype: mime || req.file.mimetype,
      originalname: req.file.originalname,
    });

    // 2) Upload media to 360dialog to get mediaId (required to send)
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname || "file",
      contentType: mime || req.file.mimetype || "application/octet-stream",
      knownLength: req.file.size,
    });

    const uploadRes = await whatsappClient.post("/media", fd, {
      headers: { ...fd.getHeaders() },
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
    const payload = {
      messaging_product: "whatsapp",
      to,
      type,
      [type]: {
        id: mediaId,
        ...(type === "document" ? { filename: req.file.originalname } : {}),
        // ✅ Voice note flag for ogg/opus
        ...(shouldSendAsVoiceNote(type, mime, req.file.originalname) ? { voice: true } : {}),
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
      text: previewText, // ✅ so UI shows 🎙️ Audio (not empty/attachment)
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
    await WhatsAppConversation.findOneAndUpdate(
      { phone: to },
      {
        $set: {
          phone: to,
          lastMessageAt: now,
          lastMessageText: previewText.slice(0, 200),
        },
      },
      { upsert: true }
    );

    // ✅ realtime emits
    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: now,
        lastMessageText: previewText.slice(0, 200),
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
