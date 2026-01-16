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
  const u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.endsWith("/v1")) return u;
  if (u.endsWith("/v1/")) return u.replace(/\/v1\/$/, "/v1");
  return `${u}/v1`;
}

const WHATSAPP_V1_BASE =
  normalizeBaseUrl(process.env.WHATSAPP_BASE_URL) || "https://waba-v2.360dialog.io/v1";

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

function normalizeLanguage(v = "en") {
  const s = String(v || "en").trim();
  return s || "en";
}

function normalizeCategory(v = "") {
  const s = String(v || "").trim().toUpperCase();
  return s || "UTILITY";
}

function normalizeStatus(raw = "") {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return "UNKNOWN";
  if (v.includes("APPROV")) return "APPROVED";
  if (v.includes("REJECT") || v.includes("DISAPPROV")) return "REJECTED";
  if (v.includes("PEND") || v.includes("SUBMIT") || v.includes("IN_REVIEW")) return "PENDING";
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
  const body = components.find((c) => String(c?.type || "").toUpperCase() === "BODY");
  return String(body?.text || "");
}

function getFooterFromComponents(components = []) {
  const footer = components.find((c) => String(c?.type || "").toUpperCase() === "FOOTER");
  return String(footer?.text || "");
}

function getHeaderMetaFromComponents(components = []) {
  const header = components.find((c) => String(c?.type || "").toUpperCase() === "HEADER");
  const format = String(header?.format || "").toUpperCase(); // TEXT / IMAGE / VIDEO / DOCUMENT
  const text = String(header?.text || "");

  return {
    headerFormat: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(format) ? format : "",
    headerText: text,
  };
}

// capture example media handles for HEADER media templates (helps frontend enforce upload)
// 360 can return example header handles under "example.header_handle" or variants
function getHeaderExampleFromComponents(components = []) {
  const header = components.find((c) => String(c?.type || "").toUpperCase() === "HEADER");
  const ex = header?.example;

  if (!ex) return [];

  const h = ex?.header_handle ?? ex?.header_handles ?? ex?.HEADER_HANDLE ?? null;

  if (Array.isArray(h)) return h.filter(Boolean).map(String);
  if (typeof h === "string" && h.trim()) return [h.trim()];

  // sometimes example is directly an array
  if (Array.isArray(ex)) return ex.filter(Boolean).map(String);

  return [];
}

// 360dialog list response can be: array OR {data: []} OR {templates: []} etc.
function extractTemplateList(data) {
  if (Array.isArray(data)) return data;

  // common direct shapes
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.templates)) return data.templates;
  if (Array.isArray(data?.waba_templates)) return data.waba_templates;

  // nested shapes (seen in some providers/proxies)
  if (Array.isArray(data?.data?.data)) return data.data.data;

  if (Array.isArray(data?.payload?.data)) return data.payload.data;
  if (Array.isArray(data?.payload?.templates)) return data.payload.templates;
  if (Array.isArray(data?.payload?.data?.data)) return data.payload.data.data;

  if (Array.isArray(data?.templates?.data)) return data.templates.data;

  return [];
}

// normalize 360 errors to something readable on UI
function normalizeProviderError(err) {
  const data = err?.response?.data;
  if (!data) return { error: err?.message || "UNKNOWN_ERROR" };
  return data;
}

/* ===============================
   GET /api/whatsapp/templates
   Returns templates FROM MONGO
================================ */
router.get("/", async (req, res) => {
  try {
    const templates = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();

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
   GET /api/whatsapp/templates/by-name/:name
   Handy for debugging send-template issues
================================ */
router.get("/by-name/:name", async (req, res) => {
  try {
    const name = normalizeName(req.params.name || "");
    if (!name) return res.status(400).json({ success: false, error: "name required" });

    const tpl = await WhatsAppTemplate.findOne({ name }).lean();
    return res.json({ success: true, template: tpl || null });
  } catch (err) {
    console.error("GET BY NAME ERROR:", err);
    res.status(500).json({ success: false, error: "GET_BY_NAME_FAILED" });
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

    if (
      !payload.category ||
      !cleanName ||
      !Array.isArray(payload.components) ||
      !payload.components.length
    ) {
      return res.status(400).json({
        success: false,
        error: "category, name, components are required",
      });
    }

    // Send to 360dialog
    const createResp = await whatsappClient.post("/configs/templates", {
      ...payload,
      name: cleanName,
      category: normalizeCategory(payload.category),
      language: normalizeLanguage(payload.language || "en"),
    });

    const components = payload.components || [];
    const body = getBodyFromComponents(components);
    const footer = getFooterFromComponents(components);
    const headerMeta = getHeaderMetaFromComponents(components);
    const headerExample = getHeaderExampleFromComponents(components);

    // Save locally (PENDING until sync updates status)
    const doc = await WhatsAppTemplate.findOneAndUpdate(
      { name: cleanName },
      {
        $set: {
          name: cleanName,
          category: normalizeCategory(payload.category),
          language: normalizeLanguage(payload.language || "en"),
          body: body || "",
          footer: footer || "",
          components,
          status: "PENDING",
          rejectionReason: "",
          raw360: createResp?.data || {},
          lastSubmittedAt: new Date(),

          // avoid stale values (always set)
          headerFormat: headerMeta.headerFormat || "",
          headerText: headerMeta.headerText || "",
          headerExampleHandles: headerExample || [],
        },
      },
      { upsert: true, new: true }
    ).lean();

    res.json({ success: true, template: doc });
  } catch (err) {
    console.error("CREATE ERROR:", err.response?.data || err);

    // friendly duplicate handling
    const msg = String(err?.response?.data?.message || "");
    if (
      err?.response?.status === 409 ||
      msg.toLowerCase().includes("already exists") ||
      msg.toLowerCase().includes("duplicate")
    ) {
      return res.status(409).json({
        success: false,
        error: { message: "Template name already exists. Choose a different name." },
      });
    }

    res.status(err.response?.status || 400).json({
      success: false,
      error: normalizeProviderError(err),
    });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const endpointsToTry = ["/configs/templates", "/configs/templates?limit=500", "/templates"];

    let list = [];
    let lastRaw = null;
    let usedEndpoint = "";

    for (const ep of endpointsToTry) {
      try {
        const r = await whatsappClient.get(ep);
        lastRaw = r.data;
        const extracted = extractTemplateList(r.data);
        if (extracted.length) {
          list = extracted;
          usedEndpoint = ep;
          break;
        }
      } catch (e) {
        lastRaw = e.response?.data || null;
      }
    }

    if (!list.length) {
      console.log("SYNC: No templates returned. usedEndpoint:", usedEndpoint || "none");
      console.log("SYNC: Raw response keys:", Object.keys(lastRaw || {}));
    }

    const ops = [];
    const syncAt = new Date();

    for (const t of list) {
      const rawName = t?.name || t?.template?.name;
      if (!rawName) continue;

      const name = normalizeName(rawName);
      const status = pickStatus(t);
      const components = pickComponents(t);

      const body = getBodyFromComponents(components);
      const footer = getFooterFromComponents(components);
      const headerMeta = getHeaderMetaFromComponents(components);
      const headerExample = getHeaderExampleFromComponents(components);

      const rejectionReason =
        t?.rejectionReason ||
        t?.reason ||
        t?.template?.rejectionReason ||
        t?.template?.reason ||
        "";

      ops.push({
        updateOne: {
          filter: { name },
          update: {
            $set: {
              name,
              language: normalizeLanguage(t?.language || t?.template?.language || "en"),
              category: normalizeCategory(t?.category || t?.template?.category || ""),
              status,
              rejectionReason: String(rejectionReason || ""),
              body: body || "",
              footer: footer || "",
              components: components || [],
              raw360: t,
              syncedAt: syncAt,

              // avoid stale values (always set)
              headerFormat: headerMeta.headerFormat || "",
              headerText: headerMeta.headerText || "",
              headerExampleHandles: headerExample || [],
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) await WhatsAppTemplate.bulkWrite(ops);

    const templates = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();

    res.json({
      success: true,
      templates: templates || [],
      meta: {
        lastSyncAt: syncAt,
        inSync: true,
        pulledCount: list.length,
        upsertedCount: ops.length,
        usedEndpoint: usedEndpoint || null,
      },
    });
  } catch (err) {
    console.error("SYNC ERROR:", err.response?.data || err);
    res.status(500).json({
      success: false,
      error: normalizeProviderError(err),
    });
  }
});

router.post("/:id/resubmit", async (req, res) => {
  try {
    const tpl = await WhatsAppTemplate.findById(req.params.id).lean();
    if (!tpl) return res.status(404).json({ success: false, error: "NOT_FOUND" });

    const payload = {
      name: tpl.name,
      category: normalizeCategory(tpl.category),
      language: normalizeLanguage(tpl.language || "en"),
      components: tpl.components || [],
    };

    const r = await whatsappClient.post("/configs/templates", payload);

    const updated = await WhatsAppTemplate.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: "PENDING",
          rejectionReason: "",
          raw360: r?.data || {},
          lastSubmittedAt: new Date(),
        },
      },
      { new: true }
    ).lean();

    return res.json({ success: true, template: updated });
  } catch (err) {
    console.error("RESUBMIT ERROR:", err.response?.data || err);
    res.status(err.response?.status || 400).json({
      success: false,
      error: normalizeProviderError(err),
    });
  }
});

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
