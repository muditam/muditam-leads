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
  if (u.endsWith("/v1")) return u;
  return `${u}/v1`;
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

// Always send/store wa_id with country code.
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

// Find highest {{n}} index in BODY
function maxVarIndex(bodyText) {
  const text = String(bodyText || "");
  let max = 0;
  for (const m of text.matchAll(/{{\s*(\d+)\s*}}/g)) {
    const n = Number(m[1] || 0);
    if (n > max) max = n;
  }
  return max;
}

function extractTextFromInbound(msg) {
  if (!msg) return "";
  if (msg.type === "text") return msg.text?.body || "";
  if (msg.type === "button") return msg.button?.text || "";
  if (msg.type === "interactive") {
    const i = msg.interactive || {};
    return (
      i.button_reply?.title ||
      i.list_reply?.title ||
      i.list_reply?.description ||
      ""
    );
  }
  return "";
}

// BODY text picker (from your DB fields OR raw360)
function pickBodyTextFromTemplateDoc(tpl) {
  if (!tpl) return "";
  if (tpl.body) return String(tpl.body || "");

  const comps =
    (Array.isArray(tpl.components) && tpl.components) ||
    (Array.isArray(tpl.raw360?.components) && tpl.raw360.components) ||
    (Array.isArray(tpl.raw360?.template?.components) &&
      tpl.raw360.template.components) ||
    [];

  const body = comps.find(
    (c) => String(c?.type || "").toUpperCase() === "BODY"
  );
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
    const exists = await WhatsAppMessage.findOne({ waId: doc.waId })
      .select("_id")
      .lean();
    if (exists) return null;
  }
  return WhatsAppMessage.create(doc);
}

function safeAxiosError(err) {
  const status = err?.response?.status || 500;
  const data = err?.response?.data || null;
  const msg =
    (typeof data === "string" ? data : data?.message) ||
    err?.message ||
    "Request failed";

  return {
    status,
    message: msg,
    data,
  };
}

/* ================================
   GET CONVERSATIONS (from DB)
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
   GET MESSAGES (from DB)
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
   - requires correct # of variables
   - IMPORTANT: return REAL 360dialog error (no blind 500)
================================ */
router.post("/send-template", async (req, res) => {
  try {
    const { to, templateName, language = "en", parameters = [] } = req.body || {};

    const phone = normalizeWaId(to);
    const tplNorm = normalizeTemplateName(templateName);
    const params = Array.isArray(parameters)
      ? parameters.map((x) => String(x ?? ""))
      : [];

    if (!phone || !tplNorm) {
      return res
        .status(400)
        .json({ success: false, message: "to + templateName required" });
    }

    const tpl = await WhatsAppTemplate.findOne({ name: tplNorm }).lean();
    const status = String(tpl?.status || "UNKNOWN").toUpperCase();

    if (status !== "APPROVED") {
      return res.status(400).json({
        success: false,
        message: `Template not approved in DB: ${tplNorm} (${status})`,
        hint: "Run POST /api/whatsapp/templates/sync",
      });
    }

    const bodyText = pickBodyTextFromTemplateDoc(tpl);
    const requiredCount = maxVarIndex(bodyText);

    if (!bodyText) {
      return res.status(400).json({
        success: false,
        message:
          "Template BODY text not available in DB for this template. (Fix sync to store BODY text.)",
        hint: "Update templates sync to store BODY (see updated whatsappTemplates.routes.js below).",
      });
    }

    if (requiredCount > 0 && params.length < requiredCount) {
      return res.status(400).json({
        success: false,
        message: `Missing template variables. Required ${requiredCount}, got ${params.length}.`,
        requiredCount,
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
          requiredCount > 0
            ? [
                {
                  type: "body",
                  parameters: params
                    .slice(0, requiredCount)
                    .map((v) => ({ type: "text", text: String(v) })),
                },
              ]
            : [],
      },
    };

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

    res.json({ success: true });
  } catch (err) {
    const e = safeAxiosError(err);
    console.error("WhatsApp template send error:", e.data || e.message);

    // ✅ return the same status 360dialog returns (usually 400),
    // so UI can show the real reason
    return res.status(e.status).json({
      success: false,
      message: "Send template failed",
      providerStatus: e.status,
      providerError: e.data || e.message,
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
      return res
        .status(400)
        .json({ success: false, message: "to + text required" });
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
    const e = safeAxiosError(err);
    console.error("WhatsApp text send error:", e.data || e.message);

    return res.status(e.status).json({
      success: false,
      message: "Send text failed",
      providerStatus: e.status,
      providerError: e.data || e.message,
    });
  }
});

/* ================================
   WEBHOOK VERIFY
================================ */
router.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token &&
      token === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

/* ================================
   WEBHOOK (incoming messages)
   NOTE: chat history only exists if this works.
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

        // inbound messages
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
