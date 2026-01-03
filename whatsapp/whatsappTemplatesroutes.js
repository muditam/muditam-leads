// routes/whatsappTemplates.routes.js
const express = require("express");
const axios = require("axios");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const router = express.Router();

/* ================================
   Base URL normalize (avoid /v1/v1)
   Use: https://waba-v2.360dialog.io  (recommended)
================================ */
function normalizeBaseUrl(raw = "") {
  const u = String(raw || "").replace(/\/+$/, "");
  if (!u) return "";
  return u.endsWith("/v1") ? u : `${u}/v1`;
}

// If you set WHATSAPP_BASE_URL="https://waba-v2.360dialog.io"
const WHATSAPP_V1_BASE =
  normalizeBaseUrl(process.env.WHATSAPP_BASE_URL) ||
  "https://waba-v2.360dialog.io/v1";

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
function normalizeName(v = "") {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 250);
}

function normalizeStatus(raw = "") {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return "UNKNOWN";
  if (v.includes("APPROV")) return "APPROVED";
  if (v.includes("REJECT") || v.includes("DISAPPROV")) return "REJECTED";
  if (v.includes("PEND") || v.includes("SUBMIT") || v.includes("IN_REVIEW"))
    return "PENDING";
  return v;
}

// 360 sometimes nests fields differently
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

function pickComponents(t) {
  return (
    (Array.isArray(t?.components) && t.components) ||
    (Array.isArray(t?.template?.components) && t.template.components) ||
    []
  );
}

function getBodyFromComponents(components = []) {
  const body = components.find(
    (c) => String(c?.type || "").toUpperCase() === "BODY"
  );
  return String(body?.text || "");
}

function getFooterFromComponents(components = []) {
  const footer = components.find(
    (c) => String(c?.type || "").toUpperCase() === "FOOTER"
  );
  return String(footer?.text || "");
}

// 360dialog list response can be: array OR {data: []} OR {templates: []} etc.
function extractTemplateList(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.templates)) return data.templates;
  if (Array.isArray(data?.waba_templates)) return data.waba_templates;

  // sometimes: { success:true, payload:{data:[]} }
  if (Array.isArray(data?.payload?.data)) return data.payload.data;
  if (Array.isArray(data?.payload?.templates)) return data.payload.templates;

  return [];
}

/* ===============================
   GET /api/whatsapp/templates
   Returns templates FROM MONGO
================================ */
router.get("/", async (req, res) => {
  try {
    const templates = await WhatsAppTemplate.find({})
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      templates: templates || [],
      meta: {
        lastSyncAt: templates?.[0]?.syncedAt || null,
        inSync: true,
      },
    });
  } catch (err) {
    console.error("LIST ERROR:", err);
    res.status(500).json({ success: false, error: "LIST_FAILED" });
  }
});

/* ===============================
   POST /api/whatsapp/templates
   Create template (send to 360) + save in Mongo
================================ */
router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};
    const cleanName = normalizeName(payload.name);

    if (!payload.category || !cleanName || !payload.components?.length) {
      return res.status(400).json({
        success: false,
        error: "category, name, components are required",
      });
    }

    // Send to 360dialog
    // Endpoint: POST /configs/templates
    const createResp = await whatsappClient.post("/configs/templates", {
      ...payload,
      name: cleanName,
    });

    const components = payload.components || [];
    const body = getBodyFromComponents(components);
    const footer = getFooterFromComponents(components);

    // Save locally (PENDING until sync updates status)
    const doc = await WhatsAppTemplate.findOneAndUpdate(
      { name: cleanName },
      {
        $set: {
          name: cleanName,
          category: String(payload.category || "").toUpperCase(),
          language: payload.language || "en",
          body: body || "",
          footer: footer || "",
          components,
          status: "PENDING",
          raw360: createResp?.data || {},
          lastSubmittedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    ).lean();

    res.json({ success: true, template: doc });
  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err);
    res.status(400).json({
      success: false,
      error: err.response?.data || "CREATE_FAILED",
    });
  }
});

/* ===============================
   POST /api/whatsapp/templates/sync
   Sync from 360dialog -> upsert into Mongo
================================ */
router.post("/sync", async (req, res) => {
  try {
    const r = await whatsappClient.get("/configs/templates");

    const list = extractTemplateList(r.data);

    // If still empty, log for debugging
    if (!list.length) {
      console.log("SYNC: No templates returned. Raw response keys:", Object.keys(r.data || {}));
    }

    const ops = [];

    for (const t of list) {
      const rawName = t?.name || t?.template?.name;
      if (!rawName) continue;

      const name = normalizeName(rawName);
      const status = pickStatus(t);
      const components = pickComponents(t);

      const body = getBodyFromComponents(components);
      const footer = getFooterFromComponents(components);

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
              body: body || "",
              footer: footer || "",
              components: components || [],
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

    res.json({
      success: true,
      templates: templates || [],
      meta: {
        lastSyncAt: new Date(),
        inSync: true,
        pulledCount: list.length,
        upsertedCount: ops.length,
      },
    });
  } catch (err) {
    console.error("SYNC ERROR:", err.response?.data || err);
    res.status(500).json({
      success: false,
      error: err.response?.data || "SYNC_FAILED",
    });
  }
});

/* ===============================
   DELETE /api/whatsapp/templates/:id
   Deletes FROM MONGO only
================================ */
router.delete("/:id", async (req, res) => {
  try {
    await WhatsAppTemplate.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ success: false, error: "DELETE_FAILED" });
  }
});

module.exports = router;
