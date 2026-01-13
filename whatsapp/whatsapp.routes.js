// routes/whatsapp.routes.js
const express = require("express");
const axios = require("axios");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");

const router = express.Router();

/* ================================
   360dialog client
================================ */
const whatsappClient = axios.create({
  baseURL: "https://waba-v2.360dialog.io",
  headers: {
    "D360-API-KEY": process.env.WHATSAPP_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

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

/* ================================
   Socket emit helpers (rooms: wa:<last10>)
   ✅ FIX: INBOUND must emit to customer's room (from)
================================ */
const roomForPhone10 = (p10) => `wa:${String(p10 || "").slice(-10)}`;

const emitToPhone10 = (req, phone10, event, payload) => {
  const io = req?.app?.get("io");
  if (!io) return;
  const p10 = last10(phone10);
  if (!p10) return;
  io.to(roomForPhone10(p10)).emit(event, payload);
};

// ✅ FIXED: choose customer phone based on direction
const customerPhoneFromMsg = (msgDoc) => {
  const dir = String(msgDoc?.direction || "").toUpperCase();
  if (dir === "INBOUND") return msgDoc?.from;   // customer
  if (dir === "OUTBOUND") return msgDoc?.to;   // customer
  return msgDoc?.to || msgDoc?.from;
};

// ✅ Emit message in a shape frontend already supports: { phone10, message }
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
   ✅ Mark conversation as read
   Frontend calls:
     POST /api/whatsapp/conversations/mark-read
     body: { phone: "<digits>" }
   ✅ Also emits realtime patch so other tabs update instantly
================================ */
router.post("/conversations/mark-read", async (req, res) => {
  try {
    const phoneRaw = req.body?.phone || "";
    const p10 = last10(phoneRaw);
    if (!p10) return res.status(400).json({ message: "phone required" });

    const now = new Date();

    // Match both "91xxxxxxxxxx" and "xxxxxxxxxx" by regex ending in last10
    const updated = await WhatsAppConversation.findOneAndUpdate(
      { phone: new RegExp(`${p10}$`) },
      { $set: { unreadCount: 0, lastReadAt: now } },
      { new: true }
    ).lean();

    // ✅ realtime patch
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
        assignedToLabel = lead.healthExpertAssigned || lead.agentAssigned || "Unassigned";
      } else if (customer) {
        displayName = customer.name || p10;
        assignedToLabel = customer.assignedTo || "Unassigned";
      }

      return { ...conv, displayName, assignedToLabel };
    });

    const isAdmin = role === "Manager" || role === "Developer";
    if (!isAdmin) {
      enriched = enriched.filter(
        (chat) =>
          String(chat.assignedToLabel).toLowerCase() === String(userName).toLowerCase()
      );
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
    console.error(e);
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
    console.error(e);
    res.status(500).json({ message: "Failed to load templates" });
  }
});

/* ================================
   SEND TEXT
   ✅ realtime emits to customer room (to)
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text?.trim()) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const convo = await WhatsAppConversation.findOne({ phone }).lean();
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
      waId: r.data.messages?.[0]?.id,
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
      { phone },
      {
        $set: {
          phone,
          lastMessageAt: now,
          lastMessageText: text.slice(0, 200),
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
        lastMessageText: text.slice(0, 200),
        lastOutboundAt: now,
        unreadCount: 0,
      },
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Send text error:", e.response?.data || e);
    res.status(400).json({
      message: "Send text failed",
      providerError: e.response?.data || null,
    });
  }
});

/* ================================
   SEND TEMPLATE
   ✅ realtime emits to customer room (to)
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, parameters = [], renderedText = "" } = req.body;
    const phone = normalizeWaId(to);
    const p10 = last10(phone);

    const tpl = await WhatsAppTemplate.findOne({ name: templateName }).lean();
    if (!tpl) return res.status(400).json({ message: "Template not found" });
    if (tpl.status !== "APPROVED")
      return res.status(400).json({ message: "Template not approved" });

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

    const clientText = String(renderedText || "").trim();
    const serverBody = extractTemplateBodyText(tpl);
    const serverText = serverBody ? applyTemplateVars(serverBody, parameters) : "";
    const finalText = clientText || serverText || `[TEMPLATE] ${tpl.name}`;

    const created = await WhatsAppMessage.create({
      waId: r.data.messages?.[0]?.id,
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

    await WhatsAppConversation.findOneAndUpdate(
      { phone },
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
        unreadCount: 0,
      },
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(400).json({
      message: "Send template failed",
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

          // ✅ realtime tick update (emit to customer's room)
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
        -------------------------- */
        const messages = Array.isArray(value.messages) ? value.messages : [];

        for (const msg of messages) {
          if (!msg?.id || !msg?.from) continue;

          const from = normalizeWaId(msg.from); // customer
          const to = businessPhone || normalizeWaId(value.metadata?.display_phone_number || "");

          // ignore echo
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
              let mediaUrl = "";
              try {
                const infoRes = await whatsappClient.get(`/media/${mediaId}`);
                mediaUrl = infoRes.data?.url || "";
              } catch {
                mediaUrl = "";
              }

              media = {
                id: mediaId,
                url: mediaUrl,
                mime: obj.mime_type || "",
                filename: obj.filename || "",
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
            (media?.filename ? `${media.filename}` : media ? "Media" : "");

          const windowExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

          const updatedConv = await WhatsAppConversation.findOneAndUpdate(
            { phone: from },
            {
              $set: {
                phone: from,
                lastMessageAt: now,
                lastMessageText: previewText,
                windowExpiresAt: windowExpiry,
                lastInboundAt: now,
              },
              $inc: { unreadCount: 1 },
            },
            { upsert: true, new: true }
          ).lean();

          // ✅ realtime inbound message + patch (emit to customer's room)
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