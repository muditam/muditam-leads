// routes/whatsappTemplates.routes.js
const express = require("express");
const axios = require("axios");

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

/** 360dialog client */
const whatsappClient = axios.create({
  baseURL: WHATSAPP_V1_BASE,
  headers: {
    "D360-API-KEY": process.env.WHATSAPP_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

/* =========================
   Helpers
========================= */
function normalizeTemplateName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 250);
}

function normalizeStatus(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return "UNKNOWN";
  if (v.includes("APPROV")) return "APPROVED";
  if (v.includes("REJECT") || v.includes("DISAPPROV")) return "REJECTED";
  if (v.includes("PEND") || v.includes("SUBMIT") || v.includes("IN_REVIEW"))
    return "PENDING";
  return v;
}

function pickStatus(t) {
  const candidates = [
    t?.status,
    t?.template_status,
    t?.approval_status,
    t?.state,
    t?.event,
    t?.template?.status,
    t?.template?.template_status,
    t?.template?.approval_status,
    t?.template?.state,
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string") return normalizeStatus(c);
    if (typeof c === "object") {
      const inner = c.status || c.state || c.event || c.approval_status;
      if (inner) return normalizeStatus(inner);
    }
  }
  return "UNKNOWN";
}

function getComponentsFrom360(t) {
  return (
    (Array.isArray(t?.components) && t.components) ||
    (Array.isArray(t?.template?.components) && t.template.components) ||
    []
  );
}

function pickBodyFromComponents(components = []) {
  const body = components.find(
    (c) => String(c?.type || "").toUpperCase() === "BODY"
  );
  return String(body?.text || "");
}

function pickHeaderFromComponents(components = []) {
  const header = components.find(
    (c) => String(c?.type || "").toUpperCase() === "HEADER"
  );
  if (!header) return {};
  return {
    type: String(header?.format || "").toUpperCase(), // TEXT/IMAGE/VIDEO/DOCUMENT
    text: header?.text || "",
    mediaUrl: "", // 360 doesn't always return URL
    filename: "",
  };
}

function pickFooterFromComponents(components = []) {
  const footer = components.find(
    (c) => String(c?.type || "").toUpperCase() === "FOOTER"
  );
  return String(footer?.text || "");
}

function pickButtonsFromComponents(components = []) {
  const btn = components.find(
    (c) => String(c?.type || "").toUpperCase() === "BUTTONS"
  );
  const buttons = Array.isArray(btn?.buttons) ? btn.buttons : [];
  return buttons.map((b) => ({
    type: String(b?.type || "").toUpperCase(),
    text: String(b?.text || ""),
    url: b?.url || "",
    phoneNumber: b?.phone_number || "",
  }));
}

/** =========================
 * LIST from Mongo
========================= */
router.get("/", async (req, res) => {
  try {
    const templates = await WhatsAppTemplate.find({})
      .sort({ updatedAt: -1 })
      .lean();
    res.json(templates);
  } catch (err) {
    console.error("Templates list error:", err);
    res.status(500).json({ success: false });
  }
});
 
router.post("/sync", async (req, res) => {
  try {
    const r = await whatsappClient.get("/configs/templates");
    const data = r.data;

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.templates)
      ? data.templates
      : Array.isArray(data?.data)
      ? data.data
      : [];

    const ops = [];

    for (const t of list) {
      const rawName = t?.name || t?.template?.name;
      if (!rawName) continue;

      const name = normalizeTemplateName(rawName);
      const status = pickStatus(t);

      const components = getComponentsFrom360(t);
      const body = pickBodyFromComponents(components);
      const header = pickHeaderFromComponents(components);
      const footer = pickFooterFromComponents(components);
      const buttons = pickButtonsFromComponents(components);

      ops.push({
        updateOne: {
          filter: { name },
          update: {
            $set: {
              name,
              language: t?.language || t?.template?.language || "en",
              category: String(t?.category || t?.template?.category || "").toUpperCase(),
              status,
              rejectionReason: t?.reason || t?.rejectionReason || "",
              // ✅ IMPORTANT: store BODY so UI can detect variables
              body,
              header,
              footer,
              buttons,
              components, // optional but useful
              raw360: t,
              syncedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) await WhatsAppTemplate.bulkWrite(ops);

    const templates = await WhatsAppTemplate.find({})
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ success: true, count: ops.length, templates });
  } catch (err) {
    console.error("Templates sync error:", err.response?.data || err);
    res.status(500).json({
      success: false,
      error: err.response?.data || "SYNC_FAILED",
    });
  }
});

module.exports = router;
