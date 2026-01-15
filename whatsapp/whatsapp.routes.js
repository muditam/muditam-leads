// routes/whatsapp.routes.js
const express = require("express");
const axios = require("axios");
const AWS = require("aws-sdk");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");

const router = express.Router();

/* ================================
   360dialog base url normalize (avoid /v1/v1)
   Prefer: https://waba-v2.360dialog.io
================================ */
function normalizeBaseUrl(raw = "") {
  const u = String(raw || "").replace(/\/+$/, "");
  if (!u) return "";
  return u.endsWith("/v1") ? u : `${u}/v1`;
}

const WHATSAPP_V1_BASE =
  normalizeBaseUrl(process.env.WHATSAPP_BASE_URL) || "https://waba-v2.360dialog.io/v1";

/* ================================
   360dialog client
================================ */
const whatsappClient = axios.create({
  baseURL: WHATSAPP_V1_BASE,
  headers: {
    "D360-API-KEY": process.env.WHATSAPP_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

/* ================================
   Wasabi S3 client (for inbound media persistence)
================================ */
const WASABI_ENDPOINT = process.env.WASABI_ENDPOINT; // e.g. https://s3.ap-southeast-1.wasabisys.com
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

const roomForPhone10 = (p10) => `wa:${String(p10 || "").slice(-10)}`;

const emitToPhone10 = (req, phone10, event, payload) => {
  const io = req?.app?.get("io");
  if (!io) return;
  const p10 = last10(phone10);
  if (!p10) return;
  io.to(roomForPhone10(p10)).emit(event, payload);
};

// ✅ choose customer phone based on direction (matches frontend logic)
const customerPhoneFromMsg = (msgDoc) => {
  const dir = String(msgDoc?.direction || "").toUpperCase();
  if (dir === "INBOUND") return msgDoc?.from; // customer
  if (dir === "OUTBOUND") return msgDoc?.to; // customer
  return msgDoc?.to || msgDoc?.from;
};

// ✅ Emit message in shape frontend supports: { phone10, message }
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

/* ================================
   Template helpers (server-side preview text)
================================ */
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

/* ================================
   ✅ Inbound media: download from 360dialog + upload to Wasabi
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
  // Some 360dialog URLs require D360-API-KEY, some work without. Try with header first.
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

async function uploadInboundToWasabi({ buffer, mime, filename, from10, mediaId, msgType }) {
  if (!s3 || !WASABI_BUCKET) return null;

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ext = extFromMime(mime);
  const safeName = filename ? String(filename).replace(/[^\w.\-() ]+/g, "_") : "";
  const base = safeName || `${msgType || "media"}_${from10 || "unknown"}_${mediaId || Date.now()}.${ext}`;
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
   ✅ Mark conversation as read
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

    emitConversationPatch(req, { phone10: p10, patch: { unreadCount: 0, lastReadAt: now } });

    return res.json({ success: true, conversation: updated || null });
  } catch (e) {
    console.error("mark-read error:", e);
    return res.status(500).json({ message: e.message || "mark-read failed" });
  }
});

/* ================================
   GET CONVERSATIONS (ENRICHED)
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
        assignedToLabel = lead.healthExpertAssigned || lead.agentAssigned || "Unassigned";
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
      enriched = enriched.filter((chat) => String(chat.assignedToLabel || "").toLowerCase() === u);
    }

    res.json(enriched);
  } catch (e) {
    console.error("Conversation load error:", e);
    res.status(500).json({ message: "Failed to load conversations" });
  }
});

/* ================================
   GET MESSAGES
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
   GET TEMPLATES
================================ */
router.get("/templates", async (req, res) => {
  try {
    const tpls = await WhatsAppTemplate.find({})
      .sort({ updatedAt: -1 })
      .lean();
    res.json(tpls || []);
  } catch (e) {
    console.error("load templates error:", e);
    res.status(500).json({ message: "Failed to load templates" });
  }
});

/* ================================
   SEND TEXT
   - requires session window active (windowExpiresAt)
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text?.trim()) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    // robust convo lookup (handles stored phone with 91 or raw)
    const convo = await WhatsAppConversation.findOne({ phone: new RegExp(`${p10}$`) }).lean();
    if (!convo?.windowExpiresAt || convo.windowExpiresAt < new Date()) {
      return res.status(400).json({
        message: "Session expired. Use template message.",
        code: "SESSION_EXPIRED",
      });
    }

    const payload = {
      messaging_product: "whatsapp",
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

    // keep conversation phone normalized consistently
    await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone, // store normalized
          lastMessageAt: now,
          lastMessageText: text.slice(0, 200),
          lastOutboundAt: now,
          // NOTE: windowExpiresAt is driven by last inbound OR template reopen; don't change here
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
        unreadCount: 0,
      },
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Send text error:", e.response?.data || e);
    res.status(400).json({
      message: e.response?.data?.message || "Send text failed",
      providerError: e.response?.data || null,
    });
  }
});

/* ================================
   SEND TEMPLATE
   ✅ ALSO reopens the 24h session window (windowExpiresAt)
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, parameters = [], renderedText = "" } = req.body;
    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const tpl = await WhatsAppTemplate.findOne({ name: templateName }).lean();
    if (!tpl) return res.status(400).json({ message: "Template not found" });
    if (String(tpl.status || "").toUpperCase() !== "APPROVED") {
      return res.status(400).json({ message: "Template not approved" });
    }

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: tpl.name,
        language: { code: tpl.language || "en" },
        components: parameters.length
          ? [
              {
                type: "body",
                parameters: parameters.map((p) => ({
                  type: "text",
                  text: String(p ?? ""),
                })),
              },
            ]
          : [],
      },
    };

    const r = await whatsappClient.post("/messages", payload);
    const now = new Date();

    // Prefer client-rendered text; fallback to server render; fallback to tag
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
        language: tpl.language || "en",
        parameters: (parameters || []).map((x) => String(x ?? "")),
      },
      timestamp: now,
      raw: r.data,
    });

    // ✅ sending a template reopens 24h window
    const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      {
        $set: {
          phone, // store normalized
          lastMessageAt: now,
          lastMessageText: finalText.slice(0, 200),
          lastOutboundAt: now,
          windowExpiresAt: windowExpiry,
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
        windowExpiresAt: windowExpiry,
        unreadCount: 0,
      },
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Send template error:", e.response?.data || e);
    res.status(400).json({
      message: e.response?.data?.message || "Send template failed",
      providerError: e.response?.data || null,
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

        const businessPhone = normalizeWaId(value.metadata?.display_phone_number || "");

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
           ✅ increments unreadCount
           ✅ persists inbound media to Wasabi (if configured)
        -------------------------- */
        const messages = Array.isArray(value.messages) ? value.messages : [];

        for (const msg of messages) {
          if (!msg?.id || !msg?.from) continue;

          const from = normalizeWaId(msg.from); // customer
          const to = businessPhone || normalizeWaId(value.metadata?.display_phone_number || "");

          // ignore echo / weird cases
          if (from && to && from === to) continue;

          const exists = await WhatsAppMessage.findOne({ waId: msg.id }).lean();
          if (exists) continue;

          let text = "";
          let media;

          if (msg.type === "text") {
            text = msg.text?.body || "";
          } else if (msg.type === "button") {
            text = msg.button?.text || "";
          } else if (msg.type === "interactive") {
            text =
              msg.interactive?.button_reply?.title ||
              msg.interactive?.list_reply?.title ||
              "";
          } else if (["image", "video", "audio", "document", "sticker"].includes(msg.type)) {
            const obj = msg[msg.type] || {};
            const mediaId = obj.id;

            if (mediaId) {
              let providerUrl = "";
              try {
                const infoRes = await whatsappClient.get(`/media/${mediaId}`);
                providerUrl = infoRes.data?.url || "";
              } catch {
                providerUrl = "";
              }

              let finalUrl = providerUrl;
              const mime = obj.mime_type || "";
              const filename = obj.filename || "";

              // ✅ NEW: Download + upload to Wasabi if configured
              if (providerUrl) {
                try {
                  const buf = await downloadMediaBuffer(providerUrl);
                  const wasabiUrl = await uploadInboundToWasabi({
                    buffer: buf,
                    mime,
                    filename,
                    from10: last10(from),
                    mediaId,
                    msgType: msg.type,
                  });
                  if (wasabiUrl) finalUrl = wasabiUrl;
                } catch {
                  // fallback: keep providerUrl
                }
              }

              media = {
                id: mediaId,
                url: finalUrl || "",
                mime,
                filename,
                // sourceUrl: providerUrl || "", // enable if you want to keep provider URL too
              };
            }

            text = obj.caption || "";
          }

          const now = new Date(Number(msg.timestamp) * 1000 || Date.now());

          const createdInbound = await WhatsAppMessage.create({
            waId: msg.id,
            from,
            to,
            text,
            ...(media ? { media } : {}),
            direction: "INBOUND",
            type: msg.type,
            status: "delivered",
            timestamp: now,
            raw: msg,
          });

          const previewText =
            (text && text.slice(0, 200)) ||
            (media?.url
              ? (() => {
                  const mt = String(media.mime || "").toLowerCase();
                  if (mt.startsWith("image/")) return "📷 Photo";
                  if (mt.startsWith("video/")) return "🎥 Video";
                  if (mt.startsWith("audio/")) return "🎙️ Audio";
                  return media.filename ? `📎 ${media.filename}` : "📎 Attachment";
                })()
              : "");

          // customer replied => 24h window opens
          const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

          const updatedConv = await WhatsAppConversation.findOneAndUpdate(
            { phone: new RegExp(`${last10(from)}$`) },
            {
              $set: {
                phone: from, // store normalized
                lastMessageAt: now,
                lastMessageText: previewText,
                windowExpiresAt: windowExpiry,
                lastInboundAt: now,
              },
              $inc: { unreadCount: 1 },
            },
            { upsert: true, new: true }
          ).lean();

          emitMessage(req, createdInbound);
          emitConversationPatch(req, {
            phone10: last10(from),
            patch: {
              lastMessageAt: now,
              lastMessageText: previewText,
              windowExpiresAt: windowExpiry,
              lastInboundAt: now,
              unreadCount: Number(updatedConv?.unreadCount || 0),
            },
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e.response?.data || e);
    res.sendStatus(500);
  }
});

module.exports = router;
