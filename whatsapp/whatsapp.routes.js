// routes/whatsapp.routes.js
const express = require("express");
const axios = require("axios");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const router = express.Router();

/* ================================
   Base URL normalize (avoid /v1/v1)
================================ */
function normalizeBaseUrl(raw = "") {
  const u = String(raw || "").replace(/\/+$/, "");
  if (!u) return "";
  return u.endsWith("/v1") ? u : `${u}/v1`;
}
const WHATSAPP_V1_BASE = normalizeBaseUrl(process.env.WHATSAPP_BASE_URL);

/* ================================
   360dialog axios client
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
   Helpers
================================ */
function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

// Always store/send full wa_id (country code + number).
// If user provides 10 digits, prefix DEFAULT_COUNTRY_CODE (91).
function normalizeWaId(v = "") {
  const d = digitsOnly(v);
  if (!d) return "";
  if (d.length === 10) {
    const cc = digitsOnly(process.env.DEFAULT_COUNTRY_CODE || "91");
    return `${cc}${d}`;
  }
  return d;
}

function normalizeTemplateName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 250);
}

// max placeholder index in body ({{1}}, {{2}} ...)
function maxVarIndex(bodyText) {
  const text = String(bodyText || "");
  let max = 0;
  for (const m of text.matchAll(/{{\s*(\d+)\s*}}/g)) {
    const n = Number(m[1] || 0);
    if (n > max) max = n;
  }
  return max;
}

// returns sorted array of unique variable indexes found, e.g. [1,2,3]
function extractVarIndexes(bodyText) {
  const text = String(bodyText || "");
  const set = new Set();
  for (const m of text.matchAll(/{{\s*(\d+)\s*}}/g)) {
    const n = Number(m[1] || 0);
    if (n > 0) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function extractTextFromInbound(msg) {
  if (!msg) return "";
  if (msg.type === "text") return msg.text?.body || "";
  if (msg.type === "button") return msg.button?.text || "";
  if (msg.type === "interactive") {
    const i = msg.interactive || {};
    return i.button_reply?.title || i.list_reply?.title || i.list_reply?.description || "";
  }
  return "";
}

function pickBodyTextFromTemplateDoc(tpl) {
  // Priority:
  // 1) tpl.body (your Mongo field)
  // 2) tpl.components
  // 3) tpl.raw360.components / tpl.raw360.template.components
  if (tpl?.body) return String(tpl.body || "");

  const comps =
    (Array.isArray(tpl?.components) && tpl.components) ||
    (Array.isArray(tpl?.raw360?.components) && tpl.raw360.components) ||
    (Array.isArray(tpl?.raw360?.template?.components) && tpl.raw360.template.components) ||
    [];

  const body = comps.find((c) => String(c?.type || "").toUpperCase() === "BODY");
  return String(body?.text || "");
}

async function upsertConversation(phone, patch = {}) {
  const waId = normalizeWaId(phone);
  if (!waId) return null;

  return WhatsAppConversation.findOneAndUpdate(
    { phone: waId },
    {
      $set: { phone: waId, phone10: waId.slice(-10), ...patch },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
}

async function ensureMessageOnce(doc) {
  if (doc?.waId) {
    const exists = await WhatsAppMessage.findOne({ waId: doc.waId }).select("_id").lean();
    if (exists) return null;
  }
  return WhatsAppMessage.create(doc);
}

/* ================================
   GET CONVERSATIONS
================================ */
router.get("/conversations", async (req, res) => {
  try {
    const conversations = await WhatsAppConversation.find({})
      .sort({ lastMessageAt: -1 })
      .lean();
    res.json(conversations || []);
  } catch (err) {
    console.error("Get conversations error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ================================
   REBUILD CONVERSATIONS FROM MESSAGES
   Use this once if you already have messages in DB
================================ */
router.post("/conversations/rebuild", async (req, res) => {
  try {
    // Group by "other party" for each message
    const biz = normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || "");
    const biz10 = biz ? biz.slice(-10) : "";

    const rows = await WhatsAppMessage.aggregate([
      {
        $addFields: {
          peer: {
            $cond: [
              { $eq: ["$direction", "INBOUND"] },
              "$from",
              "$to",
            ],
          },
        },
      },
      { $match: { peer: { $ne: null, $ne: "" } } },
      {
        $group: {
          _id: "$peer",
          lastMessageAt: { $max: "$timestamp" },
          lastMessageText: { $last: "$text" },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);

    let upserts = 0;
    for (const r of rows) {
      const peer = normalizeWaId(r._id);
      if (!peer) continue;
      await upsertConversation(peer, {
        lastMessageAt: r.lastMessageAt || new Date(),
        lastMessageText: String(r.lastMessageText || "").slice(0, 300),
      });
      upserts++;
    }

    res.json({ success: true, upserts });
  } catch (err) {
    console.error("Rebuild conversations error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ================================
   GET MESSAGES
   Accepts full waId OR 10-digit; searches using both
================================ */
router.get("/messages", async (req, res) => {
  try {
    const q = digitsOnly(req.query.phone || "");
    if (!q) return res.status(400).json({ message: "phone is required" });

    const waId = normalizeWaId(q);
    const last10 = waId.slice(-10);

    const messages = await WhatsAppMessage.find({
      $or: [
        { from: waId },
        { to: waId },
        { from10: last10 },
        { to10: last10 },
        { from: new RegExp(`${last10}$`) },
        { to: new RegExp(`${last10}$`) },
      ],
    })
      .sort({ timestamp: 1 })
      .lean();

    res.json(messages || []);
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ================================
   SEND TEMPLATE MESSAGE
   ✅ validates variable count and returns useful errors
================================ */
router.post("/send-template", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { to, templateName, language = "en", parameters = [] } = req.body || {};

    const phone = normalizeWaId(to);
    const tplNorm = normalizeTemplateName(templateName);

    const params = Array.isArray(parameters)
      ? parameters.map((x) => String(x ?? "").trim())
      : [];

    if (!phone || !tplNorm) {
      return res.status(400).json({ success: false, message: "to + templateName required" });
    }

    const tpl = await WhatsAppTemplate.findOne({ name: tplNorm }).lean();
    const status = String(tpl?.status || "UNKNOWN").toUpperCase();

    if (status !== "APPROVED") {
      return res.status(400).json({
        success: false,
        message: `Template not approved in DB: ${tplNorm} (${status})`,
        hint: "Run POST /api/whatsapp/templates/sync and ensure webhook/status updates are working.",
      });
    }

    const bodyText = pickBodyTextFromTemplateDoc(tpl);
    if (!bodyText) {
      return res.status(400).json({
        success: false,
        message: "Template BODY text not available in DB for this template.",
        hint: "Fix sync to store BODY text (use updated templates sync route below).",
      });
    }

    const requiredMax = maxVarIndex(bodyText);
    const varIndexes = extractVarIndexes(bodyText); // e.g. [1,2,3]

    if (requiredMax > 0 && params.length < requiredMax) {
      return res.status(400).json({
        success: false,
        message: `Missing template variables. Required ${requiredMax}, got ${params.length}.`,
        requiredCount: requiredMax,
        varIndexes,
        body: bodyText,
      });
    }

    const payload = {
      to: phone,
      type: "template",
      template: {
        name: tplNorm,
        language: { code: String(language || tpl?.language || "en") },
        components:
          requiredMax > 0
            ? [
                {
                  type: "body",
                  parameters: params
                    .slice(0, requiredMax)
                    .map((v) => ({ type: "text", text: String(v) })),
                },
              ]
            : [],
      },
    };

    // Debug log (safe)
    if (process.env.WHATSAPP_DEBUG_SEND === "1") {
      console.log("[SEND TEMPLATE] payload:", JSON.stringify(payload, null, 2));
    }

    const response = await whatsappClient.post("/messages", payload);
    const now = new Date();

    await ensureMessageOnce({
      waId: response?.data?.messages?.[0]?.id,
      from: normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || ""),
      to: phone,
      from10: normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || "").slice(-10),
      to10: phone.slice(-10),
      text: "",
      direction: "OUTBOUND",
      type: "template",
      timestamp: now,
      raw: response.data,
    });

    await upsertConversation(phone, {
      lastMessageAt: now,
      windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      lastMessageText: `[TEMPLATE] ${tplNorm}`,
    });

    res.json({ success: true, ms: Date.now() - startedAt });
  } catch (err) {
    const status = err?.response?.status || 500;
    const provider = err?.response?.data;

    console.error("WhatsApp template send error:", provider || err);

    // IMPORTANT: return provider status (400 stays 400), so UI sees real reason
    res.status(status).json({
      success: false,
      message: "Send template failed",
      providerStatus: status,
      providerError: provider || null,
      hint:
        status === 400
          ? "Provider says Bad request. Usually means: missing variables, wrong language code, or template name mismatch."
          : "Check WHATSAPP_BASE_URL / WHATSAPP_API_KEY and server logs.",
    });
  }
});

/* ================================
   SEND TEXT MESSAGE
================================ */
router.post("/send-text", async (req, res) => {
  try {
    const { to, text } = req.body || {};
    const phone = normalizeWaId(to);
    const body = String(text || "").trim();

    if (!phone || !body) {
      return res.status(400).json({ success: false, message: "to + text required" });
    }

    const payload = { to: phone, type: "text", text: { body } };
    const response = await whatsappClient.post("/messages", payload);

    const now = new Date();

    await ensureMessageOnce({
      waId: response?.data?.messages?.[0]?.id,
      from: normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || ""),
      to: phone,
      from10: normalizeWaId(process.env.WHATSAPP_BUSINESS_PHONE || "").slice(-10),
      to10: phone.slice(-10),
      text: body,
      direction: "OUTBOUND",
      type: "text",
      timestamp: now,
      raw: response.data,
    });

    await upsertConversation(phone, {
      lastMessageAt: now,
      windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      lastMessageText: body.slice(0, 300),
    });

    res.json({ success: true });
  } catch (err) {
    const status = err?.response?.status || 500;
    console.error("WhatsApp text send error:", err.response?.data || err);
    res.status(status).json({
      success: false,
      message: "Send text failed",
      providerStatus: status,
      providerError: err.response?.data || null,
    });
  }
});

/* ================================
   WEBHOOK VERIFY (Meta style)
================================ */
router.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

/* ================================
   WEBHOOK (incoming messages)
   NOTE: This is what makes chats "real-time" in your DB.
================================ */
router.post("/webhook", async (req, res) => {
  try {
    if (process.env.WHATSAPP_DEBUG_WEBHOOK === "1") {
      console.log("==== WHATSAPP WEBHOOK BODY START ====");
      console.log(JSON.stringify(req.body, null, 2));
      console.log("==== WHATSAPP WEBHOOK BODY END ====");
    }

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const ch of changes) {
        const value = ch?.value || {};

        if (Array.isArray(value?.messages) && value.messages.length) {
          for (const msg of value.messages) {
            const from = normalizeWaId(msg.from);
            const to = normalizeWaId(value?.metadata?.display_phone_number || "");
            const now = new Date(Number(msg.timestamp) * 1000 || Date.now());
            const text = extractTextFromInbound(msg);

            await ensureMessageOnce({
              waId: msg.id,
              from,
              to,
              from10: from.slice(-10),
              to10: to.slice(-10),
              text,
              type: msg.type,
              direction: "INBOUND",
              timestamp: now,
              raw: msg,
            });

            await upsertConversation(from, {
              lastMessageAt: now,
              windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              lastMessageText: (text || "").slice(0, 300),
            });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    res.sendStatus(500);
  }
});

module.exports = router;
