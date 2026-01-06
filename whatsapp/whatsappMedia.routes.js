const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const AWS = require("aws-sdk");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

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

function safeFilename(name = "file") {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

async function uploadToWasabi({ buffer, mimetype, originalname }) {
  const bucket = process.env.WASABI_BUCKET;
  if (!bucket) throw new Error("WASABI_BUCKET missing");

  const key = `whatsapp-media/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${safeFilename(
    originalname
  )}`;

  const result = await s3
    .upload({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimetype || "application/octet-stream",
      ACL: "public-read",
    })
    .promise();

  // result.Location is the public URL (when public-read works)
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

    // 0) (optional) client-side limit already exists, but keep server safety
    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "Max attachment size is 5MB" });
    }

    // 1) Upload to Wasabi (store URL in DB)
    const wasabi = await uploadToWasabi({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
    });

    // 2) Upload media to 360dialog to get mediaId (required to send)
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
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
    const mime = req.file.mimetype || "";
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    const isAudio = mime.startsWith("audio/");

    const type = isImage ? "image" : isVideo ? "video" : isAudio ? "audio" : "document";

    const payload = {
      messaging_product: "whatsapp",
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

    // 4) Save in DB with Wasabi URL
    await WhatsAppMessage.create({
      waId: msgRes.data?.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to,
      direction: "OUTBOUND",
      type,
      text: "", // ✅ no "[IMAGE]" text; UI will render using media.url
      media: {
        id: mediaId,
        url: wasabi.url, // ✅ store Wasabi link here
        mime,
        filename: req.file.originalname,
      },
      timestamp: now,
      raw: msgRes.data,
    });

    await WhatsAppConversation.findOneAndUpdate(
      { phone: to },
      {
        phone: to,
        lastMessageAt: now,
        lastMessageText: type === "image" ? "📷 Photo" : `📎 ${req.file.originalname}`.slice(0, 200),
      },
      { upsert: true }
    );

    return res.json({ success: true, mediaId, mediaUrl: wasabi.url });
  } catch (e) {
    console.error("send-media error:", e.response?.data || e);
    return res.status(400).json({
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
