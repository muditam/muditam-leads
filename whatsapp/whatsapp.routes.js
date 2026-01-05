const express = require("express");
const axios = require("axios");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const router = express.Router();

/* ================================
   360dialog v2 client
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

const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

/* ================================
   GET CONVERSATIONS
================================ */
router.get("/conversations", async (req, res) => {
  try {
    const rows = await WhatsAppConversation.find({})
      .sort({ lastMessageAt: -1 })
      .lean();
    res.json(rows || []);
  } catch (e) {
    console.error(e);
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
    const last10 = waId.slice(-10);

    const msgs = await WhatsAppMessage.find({
      $or: [
        { from: waId },
        { to: waId },
        { from: new RegExp(`${last10}$`) },
        { to: new RegExp(`${last10}$`) },
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
   GET TEMPLATES (DB)
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
   SEND TEXT MESSAGE
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    const phone = normalizeWaId(to);

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
    };

    const r = await whatsappClient.post("/messages", payload);

    const now = new Date();

    await WhatsAppMessage.create({
      waId: r.data.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      text,
      direction: "OUTBOUND",
      type: "text",
      timestamp: now,
      raw: r.data,
    });

    await WhatsAppConversation.findOneAndUpdate(
      { phone },
      {
        phone,
        lastMessageAt: now,
        lastMessageText: text.slice(0, 200),
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(400).json({
      message: "Send text failed",
      providerError: e.response?.data || null,
    });
  }
});

/* ================================
   SEND TEMPLATE MESSAGE
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, parameters = [] } = req.body;
    const phone = normalizeWaId(to);

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
                  text: p,
                })),
              },
            ]
          : [],
      },
    };

    const r = await whatsappClient.post("/messages", payload);
    const now = new Date();

    await WhatsAppMessage.create({
      waId: r.data.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      text: "",
      direction: "OUTBOUND",
      type: "template",
      timestamp: now,
      raw: r.data,
    });

    await WhatsAppConversation.findOneAndUpdate(
      { phone },
      {
        phone,
        lastMessageAt: now,
        lastMessageText: `[TEMPLATE] ${tpl.name}`,
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(400).json({
      message: "Send template failed",
      providerError: e.response?.data || null,
    });
  }
});


router.get("/webhook", (req, res) => {
  return res.sendStatus(200);
});


router.post("/webhook", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = Array.isArray(value.messages) ? value.messages : [];

        for (const msg of messages) {
          if (!msg?.id || !msg?.from) continue;

          const from = normalizeWaId(msg.from);
          const to = normalizeWaId(value.metadata?.display_phone_number || "");

          // Ignore echoes
          if (from === to) continue;

          // Deduplicate
          const exists = await WhatsAppMessage.findOne({ waId: msg.id });
          if (exists) continue;

          let text = "";
          if (msg.type === "text") text = msg.text?.body || "";
          else if (msg.type === "button") text = msg.button?.text || "";
          else if (msg.type === "interactive") {
            text =
              msg.interactive?.button_reply?.title ||
              msg.interactive?.list_reply?.title ||
              "";
          }

          const now = new Date(Number(msg.timestamp) * 1000 || Date.now());

          await WhatsAppMessage.create({
            waId: msg.id,
            from,
            to,
            text,
            direction: "INBOUND",
            type: msg.type,
            timestamp: now,
            raw: msg,
          });

          await WhatsAppConversation.findOneAndUpdate(
            { phone: from },
            {
              phone: from,
              lastMessageAt: now,
              lastMessageText: text.slice(0, 200),
              windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { upsert: true }
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(500);
  }
});


module.exports = router;
