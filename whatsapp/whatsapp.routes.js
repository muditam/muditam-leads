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
  limits: { fileSize: 5 * 1024 * 1024 },
});

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
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

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

/* ================================
   Helpers
================================ */
const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);

const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

function normalizeTemplateName(v = "") {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 250);
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

// ✅ Use lastInboundAt to compute free-form window (truth source)
function freeformExpiryFromConvo(convo) {
  const t = convo?.lastInboundAt ? new Date(convo.lastInboundAt).getTime() : 0;
  if (!t) return null;
  return new Date(t + 24 * 60 * 60 * 1000);
}

function extractTemplateBodyText(tpl) {
  if (!tpl) return "";
  if (typeof tpl?.bodyText === "string") return tpl.bodyText;
  if (typeof tpl?.body === "string") return tpl.body;
  if (typeof tpl?.text === "string") return tpl.text;

  const comps = Array.isArray(tpl?.components) ? tpl.components : [];
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

function getHeaderMediaFormatFromTemplate(tpl) {
  const comps = Array.isArray(tpl?.components) ? tpl.components : [];
  const header = comps.find(
    (c) => String(c?.type || "").toUpperCase() === "HEADER"
  );
  const fmt = String(header?.format || "").toUpperCase();
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(fmt)) return fmt;
  return "";
}

function buildHeaderComponentFromMedia({ format, id, filename }) {
  const fmt = String(format || "").toUpperCase();
  const mediaId = String(id || "").trim();
  const fname = String(filename || "").trim();

  if (!mediaId) return null;

  if (fmt === "DOCUMENT") {
    return {
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            id: mediaId,
            ...(fname ? { filename: fname } : {}), // ✅ important
          },
        },
      ],
    };
  }

  if (fmt === "IMAGE") {
    return { type: "header", parameters: [{ type: "image", image: { id: mediaId } }] };
  }
  if (fmt === "VIDEO") {
    return { type: "header", parameters: [{ type: "video", video: { id: mediaId } }] };
  }
  return null;
}

async function downloadMediaWithMeta(mediaUrl) {
  const tryReq = async (withKey) => {
    const r = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      ...(withKey ? { headers: { "D360-API-KEY": process.env.WHATSAPP_API_KEY } } : {}),
    });

    const mime = String(r.headers?.["content-type"] || "").trim(); // ✅ REAL mime
    return { buffer: Buffer.from(r.data), mime };
  };

  try {
    return await tryReq(true);
  } catch {
    return await tryReq(false);
  }
}


function validateTemplateParamsOrThrow(tpl, parameters) {
  const bodyText = extractTemplateBodyText(tpl) || "";
  const matches = Array.from(bodyText.matchAll(/{{\s*(\d+)\s*}}/g));
  const neededCount = matches.length
    ? Math.max(...matches.map((m) => parseInt(m[1], 10)))
    : 0;

  const got = Array.isArray(parameters) ? parameters.length : 0;

  if (neededCount && got < neededCount) {
    const err = new Error(`Template expects ${neededCount} parameters, got ${got}`);
    err.code = "PARAM_MISMATCH";
    err.status = 400;
    throw err;
  }
}

/* ================================
   TEMPLATE HEADER MEDIA UPLOAD
================================ */
router.post("/upload-template-media", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "file required" });

    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname || "file",
      contentType: req.file.mimetype || "application/octet-stream",
      knownLength: req.file.size,
    });
    fd.append("messaging_product", "whatsapp");

    const mediaUrl = `${String(WHATSAPP_MSG_BASE || "").replace(/\/+$/, "")}/media`;

    const r = await axios.post(mediaUrl, fd, {
      headers: {
        ...fd.getHeaders(),
        "D360-API-KEY": process.env.WHATSAPP_API_KEY,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30000,
    });

    const mediaId = r?.data?.id || r?.data?.media?.id || null;
    if (!mediaId) {
      return res.status(400).json({
        message: "Upload succeeded but provider did not return media id",
        providerError: r?.data || null,
      });
    }

    return res.json({ success: true, mediaId });
  } catch (e) {
    console.error("upload-template-media error:", e.response?.data || e);
    return res.status(e.response?.status || 400).json({
      message:
        e.response?.data?.message || e.message || "Upload template media failed",
      providerError: e.response?.data || null,
    });
  }
});

/* ================================
   INBOUND MEDIA HELPERS
================================ */
function extFromMime(mime = "") {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("audio/ogg")) return "ogg";
  if (m.includes("audio/mpeg")) return "mp3";
  if (m.includes("audio/wav")) return "wav";
  return "bin";
}

async function downloadMediaBuffer(mediaUrl) {
  try {
    const r = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "D360-API-KEY": process.env.WHATSAPP_API_KEY },
    });
    return Buffer.from(r.data);
  } catch {
    const r = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    return Buffer.from(r.data);
  }
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
      ACL: "public-read",
    })
    .promise();

  return up?.Location || null;
}

/* ================================
   READ TRACKING
================================ */
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

/* ================================
   CONVERSATIONS (enriched)
================================ */
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

/* ================================
   MESSAGES
================================ */
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

/* ================================
   TEMPLATES
================================ */
router.get("/templates", async (req, res) => {
  try {
    const tpls = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();
    res.json(tpls || []);
  } catch (e) {
    console.error("load templates error:", e);
    res.status(500).json({ message: "Failed to load templates" });
  }
});

/* ================================
   SEND TEXT (FREEFORM) ✅ uses lastInboundAt
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text?.trim()) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const convo = await WhatsAppConversation.findOne({
      phone: new RegExp(`${p10}$`),
    }).lean();

    // ✅ primary: lastInboundAt, fallback: windowExpiresAt for old data
    const expiry = freeformExpiryFromConvo(convo) || convo?.windowExpiresAt || null;

    if (!expiry || expiry < new Date()) {
      return res.status(400).json({
        message: "Session expired. Use template message.",
        code: "SESSION_EXPIRED",
      });
    }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { body: text },
    };

    const r = await whatsappClient.post("/messages", payload);
    const now = new Date();

    const created = await WhatsAppMessage.create({
      waId: r.data?.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      text,
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
          lastMessageText: text.slice(0, 200),
          lastOutboundAt: now,
          // ❌ do NOT touch lastInboundAt / windowExpiresAt here
        },
      },
      { upsert: true }
    );

    emitMessage(req, created);
    emitConversationPatch(req, {
      phone10: p10,
      patch: {
        lastMessageAt: now,
        lastMessageText: text.slice(0, 200),
        lastOutboundAt: now,
      },
    });

    return res.json({ success: true });
  } catch (e) {
    const status = e.response?.status || 400;
    const data = e.response?.data || null;
    console.error("Send text error:", { status, data, message: e.message });

    return res.status(status).json({
      message: "Send text failed",
      providerError: data || { error: e.message },
    });
  }
});

/* ================================
   SEND TEMPLATE ✅ does NOT extend session window
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, parameters = [], renderedText = "", headerMedia = null } =
      req.body;

    if (!to || !templateName) {
      return res.status(400).json({ message: "to & templateName required" });
    }

    const rawDigits = String(to || "").replace(/\D/g, "");
    const normalizedTo = rawDigits.length === 10 ? `91${rawDigits}` : rawDigits;
    const phone = normalizeWaId(normalizedTo);
    const p10 = last10(phone);

    const cleanTemplateName = normalizeTemplateName(templateName);

    const tpl = await WhatsAppTemplate.findOne({ name: cleanTemplateName }).lean();
    if (!tpl) return res.status(400).json({ message: "Template not found" });

    if (String(tpl.status || "").toUpperCase() !== "APPROVED") {
      return res.status(400).json({ message: "Template not approved" });
    }
    if (String(tpl.category || "").toUpperCase() !== "UTILITY") {
      return res.status(400).json({ message: "Only UTILITY templates are allowed" });
    }

    validateTemplateParamsOrThrow(tpl, parameters);

    const lang = String(tpl.language || "").trim();
    if (!lang) {
      return res.status(400).json({
        message: "Template language missing in DB. Sync templates again.",
        code: "TEMPLATE_LANGUAGE_MISSING",
      });
    }

    const neededHeaderFmt = getHeaderMediaFormatFromTemplate(tpl);

    if (neededHeaderFmt) {
      const providedId = String(headerMedia?.id || "").trim();
      if (!providedId) {
        return res.status(400).json({
          message: `This template requires HEADER ${neededHeaderFmt}. Upload header media first and send headerMedia.id`,
          code: "HEADER_MEDIA_ID_REQUIRED",
        });
      }
    }

    const components = [];

    if (neededHeaderFmt) {
      const headerComp = buildHeaderComponentFromMedia({
        format: neededHeaderFmt,
        id: headerMedia?.id,
        filename: headerMedia?.filename,
      });

      if (!headerComp) {
        return res.status(400).json({
          message: "Invalid headerMedia. Send { id } for header media templates.",
          code: "HEADER_MEDIA_INVALID",
        });
      }
      components.push(headerComp);
    }

    if (Array.isArray(parameters) && parameters.length) {
      components.push({
        type: "body",
        parameters: parameters.map((p) => ({
          type: "text",
          text: String(p ?? ""),
        })),
      });
    }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "template",
      template: {
        name: tpl.name,
        language: { code: lang },
        ...(components.length ? { components } : {}),
      },
    };

    const r = await whatsappClient.post("/messages", payload);
    const now = new Date();

    const clientText = String(renderedText || "").trim();
    const serverBody = extractTemplateBodyText(tpl);
    const serverText = serverBody ? applyTemplateVars(serverBody, parameters) : "";
    const finalText = clientText || serverText || `[TEMPLATE] ${tpl.name}`;

    const created = await WhatsAppMessage.create({
      waId: r.data?.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      direction: "OUTBOUND",
      type: "template",
      text: finalText,
      status: "sent",
      templateMeta: {
        name: tpl.name,
        language: lang,
        parameters: (parameters || []).map((x) => String(x ?? "")),
        ...(neededHeaderFmt && headerMedia?.id
          ? {
            headerMedia: {
              format: neededHeaderFmt,
              id: String(headerMedia.id),
            },
          }
          : {}),
      },
      timestamp: now,
      raw: r.data,
    });

    // ✅ IMPORTANT: do NOT set windowExpiresAt here
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

    return res.json({ success: true });
  } catch (e) {
    const status = e?.response?.status || e?.status || 400;
    const data = e?.response?.data || null;

    console.error("Send template error:", {
      status,
      providerError: data,
      message: e?.message,
    });

    return res.status(status).json({
      message: "Send template failed",
      providerError: data || { error: e?.message || "UNKNOWN_ERROR" },
    });
  }
});

/* ================================
   WEBHOOK
================================ */
router.get("/webhook", (req, res) => res.sendStatus(200));

router.post("/webhook", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const businessPhone = normalizeWaId(
          value.metadata?.display_phone_number || ""
        );

        /* -------------------------
           1) STATUS UPDATES (ticks)
        -------------------------- */
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const waId = st?.id;
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
            const p10 = last10(customerPhone || "");
            if (p10) emitStatus(req, { phone10: p10, waId, status: newStatus });
          }
        }

        /* -------------------------
           2) INBOUND MESSAGES
        -------------------------- */
        const messages = Array.isArray(value.messages) ? value.messages : [];

        for (const msg of messages) {
          if (!msg?.id || !msg?.from) continue;

          // de-dupe (Meta may retry webhooks)
          const already = await WhatsAppMessage.findOne({ waId: msg.id })
            .select("_id")
            .lean();
          if (already) continue;

          const from = normalizeWaId(msg.from); // customer
          const to =
            businessPhone ||
            normalizeWaId(value.metadata?.display_phone_number || "");
          if (from && to && from === to) continue;

          const p10 = last10(from);
          const now = new Date();

          // For legacy compatibility, keep windowExpiresAt updated,
          // but your app should rely on lastInboundAt.
          const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

          const msgType = String(msg.type || "").toLowerCase();

          // ---------- TEXT / BUTTON / INTERACTIVE ----------
          let text = "";
          let type = msgType || "text";

          if (msgType === "text") {
            text = String(msg?.text?.body || "");
          } else if (msgType === "button") {
            text = String(msg?.button?.text || msg?.button?.payload || "");
          } else if (msgType === "interactive") {
            const it = msg?.interactive || {};
            const itType = String(it.type || "").toLowerCase();
            if (itType === "button_reply") {
              text = String(
                it?.button_reply?.title || it?.button_reply?.id || ""
              );
            } else if (itType === "list_reply") {
              text = String(it?.list_reply?.title || it?.list_reply?.id || "");
            } else {
              text = JSON.stringify(it).slice(0, 500);
            }
          }

          // ---------- MEDIA ----------
          const mediaObj =
            msg?.image || msg?.video || msg?.audio || msg?.document || null;
          const mediaId = mediaObj?.id ? String(mediaObj.id) : "";
          let media = null;

          // ✅ Decide type early (important for audio/voice notes)
          if (mediaId) {
            if (msg.image) type = "image";
            else if (msg.video) type = "video";
            else if (msg.audio) type = "audio";
            else if (msg.document) type = "document";
            else type = msgType || "document";
          } else {
            type = msgType || "text";
          }

          if (mediaId) {
            try {
              // 1) Fetch provider media URL (try /media, then /v1/media for compatibility)
              let mediaInfo;
              try {
                mediaInfo = await whatsappClient.get(`/media/${mediaId}`);
              } catch (e1) {
                mediaInfo = await whatsappClient.get(`/v1/media/${mediaId}`);
              }

              const providerUrl = String(mediaInfo?.data?.url || "").trim();
              const mimeFromInfo = String(
                mediaInfo?.data?.mime_type || mediaObj?.mime_type || ""
              ).trim();

              // 2) Build minimal media object FIRST (so UI can render even if Wasabi fails)
              const baseMime =
                (mimeFromInfo || "application/octet-stream").trim() ||
                "application/octet-stream";

              const filename =
                String(mediaObj?.filename || mediaObj?.name || "").trim() ||
                `${type || "media"}_${p10 || "unknown"}_${mediaId}.${extFromMime(
                  baseMime
                )}`;

              media = {
                id: mediaId,
                url: providerUrl || "",
                mime: baseMime,
                filename,
              };

              // 3) Optional: download + upload to Wasabi.
              //    If this fails, KEEP providerUrl so audio still plays.
              if (providerUrl) {
                try {
                  const dl = await downloadMediaWithMeta(providerUrl); // { buffer, mime }
                  const buffer = dl?.buffer || null;

                  const bestMime =
                    String(dl?.mime || mimeFromInfo || "").trim() ||
                    "application/octet-stream";

                  let wasabiUrl = null;
                  if (buffer) {
                    wasabiUrl = await uploadInboundToWasabi({
                      buffer,
                      mime: bestMime,
                      filename,
                      from10: p10,
                      mediaId,
                      msgType: type || msgType,
                    });
                  }

                  media = {
                    id: mediaId,
                    url: wasabiUrl || providerUrl || "",
                    mime: bestMime,
                    filename,
                  };
                } catch (uploadErr) {
                  console.error(
                    "Inbound Wasabi upload failed (keeping provider url):",
                    uploadErr?.response?.data || uploadErr
                  );
                }
              }

              // 4) Friendly text label (if missing)
              if (!text) {
                const t = String(type || msgType || "").toLowerCase();
                text =
                  t === "image"
                    ? "📷 Photo"
                    : t === "video"
                    ? "🎥 Video"
                    : t === "audio"
                    ? "🎙️ Audio"
                    : "📎 Attachment";
              }
            } catch (e) {
              console.error(
                "Inbound media handling failed:",
                e.response?.data || e
              );

              // ✅ still show correct label for audio
              if (!text) {
                const t = String(type || msgType || "").toLowerCase();
                text = t === "audio" ? "🎙️ Audio" : "📎 Attachment";
              }

              // ✅ keep at least mediaId so you can debug later
              if (!media) {
                media = {
                  id: mediaId,
                  url: "",
                  mime: "",
                  filename: "",
                };
              }
            }
          }

          const created = await WhatsAppMessage.create({
            waId: msg.id,
            from,
            to,
            direction: "INBOUND",
            type,
            text: String(text || "").slice(0, 4000),
            status: "received",
            timestamp: now,
            media: media || undefined,
            raw: msg,
          });

          // ✅ Conversation upsert (+ unread + session open from inbound)
          const updatedConv = await WhatsAppConversation.findOneAndUpdate(
            { phone: new RegExp(`${p10}$`) },
            {
              $set: {
                phone: from,
                lastMessageAt: now,
                lastMessageText: String(text || "").slice(0, 200),
                lastInboundAt: now,
                windowExpiresAt: windowExpiry, // keep for old fallback
              },
              $inc: { unreadCount: 1 },
            },
            { upsert: true, new: true }
          ).lean();

          emitMessage(req, created);

          // ✅ emit real unreadCount (not delta)
          emitConversationPatch(req, {
            phone10: p10,
            patch: {
              lastMessageAt: updatedConv?.lastMessageAt || now,
              lastMessageText:
                updatedConv?.lastMessageText ||
                String(text || "").slice(0, 200),
              lastInboundAt: updatedConv?.lastInboundAt || now,
              windowExpiresAt: updatedConv?.windowExpiresAt || windowExpiry,
              unreadCount: updatedConv?.unreadCount ?? 1,
            },
          });
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e.response?.data || e);
    return res.sendStatus(200);
  }
});

module.exports = router;
