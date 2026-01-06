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

// ---------- Template helpers (server-side preview text) ----------
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
   GET CONVERSATIONS (ENRICHED)
================================ */
router.get("/conversations", async (req, res) => {
  try {
    const conversations = await WhatsAppConversation.find({})
      .sort({ lastMessageAt: -1 })
      .lean();

    if (!conversations.length) return res.json([]);

    const phones10 = conversations.map((c) => last10(c.phone));

    // --- Fetch Leads ---
    const leads = await Lead.find({
      contactNumber: { $in: phones10 },
    })
      .select("contactNumber name healthExpertAssigned agentAssigned")
      .lean();

    const leadMap = {};
    leads.forEach((l) => {
      leadMap[last10(l.contactNumber)] = l;
    });

    // --- Fetch Customers (fallback only) ---
    const missingPhones = phones10.filter((p) => !leadMap[p]);

    const customers = await Customer.find({
      phone: { $in: missingPhones },
    })
      .select("phone name assignedTo")
      .lean();

    const customerMap = {};
    customers.forEach((c) => {
      customerMap[last10(c.phone)] = c;
    });

    // --- Enrich conversations ---
    const enriched = conversations.map((conv) => {
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

      return {
        ...conv,
        displayName,
        assignedToLabel,
      };
    });

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
    const tpls = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();
    res.json(tpls || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to load templates" });
  }
});

/* ================================
   SEND TEXT
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text?.trim()) {
      return res.status(400).json({ message: "to & text required" });
    }

    const phone = normalizeWaId(to);

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

    await WhatsAppMessage.create({
      waId: r.data.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      text,
      direction: "OUTBOUND",
      type: "text",
      status: "sent", // ✅ important for ticks
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
    console.error("Send text error:", e.response?.data || e);
    res.status(400).json({
      message: "Send text failed",
      providerError: e.response?.data || null,
    });
  }
});

/* ================================
   SEND TEMPLATE  ✅ store exact template text
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, parameters = [], renderedText = "" } = req.body;
    const phone = normalizeWaId(to);

    const tpl = await WhatsAppTemplate.findOne({ name: templateName }).lean();
    if (!tpl) return res.status(400).json({ message: "Template not found" });
    if (tpl.status !== "APPROVED") return res.status(400).json({ message: "Template not approved" });

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

    // ✅ compute the real message text to store
    const clientText = String(renderedText || "").trim();
    const serverBody = extractTemplateBodyText(tpl);
    const serverText = serverBody ? applyTemplateVars(serverBody, parameters) : "";
    const finalText = clientText || serverText || `[TEMPLATE] ${tpl.name}`;

    await WhatsAppMessage.create({
      waId: r.data.messages?.[0]?.id,
      from: process.env.WHATSAPP_BUSINESS_PHONE,
      to: phone,
      direction: "OUTBOUND",
      type: "template",
      text: finalText,
      status: "sent", // ✅ important for ticks
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
        phone,
        lastMessageAt: now,
        lastMessageText: finalText.slice(0, 200),
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

/* ================================
   WEBHOOK
   ✅ handles:
   - inbound messages
   - inbound media (stores media url/id)
   - delivery receipts for ticks (value.statuses)
================================ */
router.get("/webhook", (req, res) => res.sendStatus(200));

router.post("/webhook", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        /* -------------------------
           1) STATUS UPDATES (ticks)
        -------------------------- */
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const waId = st?.id;
          if (!waId) continue;

          const newStatus = String(st.status || "").toLowerCase(); // sent/delivered/read/failed
          if (!newStatus) continue;

          await WhatsAppMessage.findOneAndUpdate(
            { waId },
            { $set: { status: newStatus } },
            { new: true }
          );
        }

        /* -------------------------
           2) INBOUND MESSAGES
        -------------------------- */
        const messages = Array.isArray(value.messages) ? value.messages : [];

        for (const msg of messages) {
          if (!msg?.id || !msg?.from) continue;

          const from = normalizeWaId(msg.from);
          const to = normalizeWaId(value.metadata?.display_phone_number || "");

          // ignore echo
          if (from === to) continue;

          const exists = await WhatsAppMessage.findOne({ waId: msg.id });
          if (exists) continue;

          let text = "";
          let media; // keep undefined if not exists

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
              // NOTE: 360dialog media URLs can be short-lived. For production, download+upload to Wasabi.
              let mediaUrl = "";
              try {
                const infoRes = await whatsappClient.get(`/media/${mediaId}`);
                mediaUrl = infoRes.data?.url || "";
              } catch (e) {
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

          await WhatsAppMessage.create({
            waId: msg.id,
            from,
            to,
            text,
            ...(media ? { media } : {}),
            direction: "INBOUND",
            type: msg.type,
            status: "delivered", // inbound is already delivered to business
            timestamp: now,
            raw: msg,
          });

          await WhatsAppConversation.findOneAndUpdate(
            { phone: from },
            {
              phone: from,
              lastMessageAt: now,
              lastMessageText:
                (text && text.slice(0, 200)) ||
                (media?.filename ? `${media.filename}` : media ? "Media" : ""),
              windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { upsert: true }
          );
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
