const express = require("express");
const axios = require("axios");
const WhatsAppTemplate = require("./whatsaapModels/WhatsAppTemplate");

const router = express.Router();

/* ----------------------------------------
   TRUSTSIGNAL CONFIG
----------------------------------------- */
const TRUSTSIGNAL_API_BASE = String(
  process.env.TRUSTSIGNAL_API_BASE || "https://wpapi.trustsignal.io"
).replace(/\/+$/, "");

const TRUSTSIGNAL_API_KEY = String(process.env.TRUSTSIGNAL_API_KEY || "").trim();

const TS_PATH_TEMPLATE_LIST = "/api/v1/template";
const TS_PATH_TEMPLATE_CREATE = "/api/v1/template";
const TS_PATH_TEMPLATE_BY_ID = "/api/v1/template/:id";
const TS_PATH_TEMPLATE_UPDATE = "/v1/user-templates/update/:id";
const TS_PATH_TEMPLATE_DELETE = "/v1/user-templates/:id";

const trustsignalClient = axios.create({
  baseURL: TRUSTSIGNAL_API_BASE,
  timeout: 30000,
  validateStatus: () => true,
});

/* ----------------------------------------
   HELPERS
----------------------------------------- */
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

function isObjectLike(v) {
  return v !== null && typeof v === "object";
}

function deepPick(obj, candidates = []) {
  if (!isObjectLike(obj) && !Array.isArray(obj)) return null;

  for (const key of candidates) {
    const parts = String(key).split(".");
    let cur = obj;
    let ok = true;

    for (const p of parts) {
      if (!isObjectLike(cur) && !Array.isArray(cur)) {
        ok = false;
        break;
      }
      if (!(p in cur)) {
        ok = false;
        break;
      }
      cur = cur[p];
    }

    if (ok && cur != null && cur !== "") return cur;
  }

  return null;
}

function compilePath(pathTemplate = "", pathParams = {}) {
  let out = String(pathTemplate || "");
  for (const [k, v] of Object.entries(pathParams || {})) {
    out = out.replace(new RegExp(`:${k}\\b`, "g"), encodeURIComponent(String(v ?? "")));
  }
  return out;
}

function isHtmlLikeResponse(data, headers = {}) {
  const ct = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

  if (ct.includes("text/html")) return true;

  if (typeof data === "string") {
    const s = data.trim().toLowerCase();
    if (s.startsWith("<!doctype html")) return true;
    if (s.startsWith("<html")) return true;
    if (s.includes("<title>404")) return true;
    if (s.includes("<body")) return true;
  }

  return false;
}

function okOrThrow(resp, fallbackMessage = "Provider request failed") {
  if (resp.status >= 200 && resp.status < 300) return resp;

  const message =
    deepPick(resp.data, ["message", "error.message", "error", "details", "result.message"]) ||
    (typeof resp.data === "string" ? resp.data : "") ||
    `${fallbackMessage} (${resp.status})`;

  const err = new Error(String(message));
  err.status = resp.status;
  err.data = resp.data;
  throw err;
}

function buildHeaders(extra = {}) {
  const headers = {
    accept: "*/*",
    ...extra,
  };

  if (TRUSTSIGNAL_API_KEY) {
    headers["x-api-key"] = TRUSTSIGNAL_API_KEY;
    headers["api-key"] = TRUSTSIGNAL_API_KEY;
  }

  return headers;
}

function buildParams(extra = {}) {
  const params = {
    ...extra,
  };

  if (TRUSTSIGNAL_API_KEY) {
    params.api_key = TRUSTSIGNAL_API_KEY;
  }

  return params;
}

async function tsRequest({
  method = "GET",
  path = "",
  pathParams = {},
  params = {},
  data = undefined,
  headers = {},
}) {
  const finalPath = compilePath(path, pathParams);
  const finalUrl = `${TRUSTSIGNAL_API_BASE}${finalPath}`;

  console.log("TS REQUEST =>", method, finalUrl, buildParams(params));

  const resp = await trustsignalClient.request({
    method,
    url: finalPath,
    params: buildParams(params),
    data,
    headers: buildHeaders(headers),
  });

  okOrThrow(resp);

  if (isHtmlLikeResponse(resp.data, resp.headers || {})) {
    const err = new Error("Received HTML page instead of API JSON");
    err.status = 502;
    err.data = typeof resp.data === "string" ? resp.data.slice(0, 1000) : resp.data;
    throw err;
  }

  return {
    data: resp.data,
    status: resp.status,
    base: TRUSTSIGNAL_API_BASE,
  };
}

function extractTemplateList(data) {
  if (Array.isArray(data)) return data;
  if (!isObjectLike(data)) return [];

  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.templates)) return data.templates;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.templateList)) return data.templateList;
  if (Array.isArray(data?.response)) return data.response;

  if (Array.isArray(data?.result?.data)) return data.result.data;
  if (Array.isArray(data?.result?.templates)) return data.result.templates;
  if (Array.isArray(data?.payload?.data)) return data.payload.data;
  if (Array.isArray(data?.payload?.templates)) return data.payload.templates;
  if (Array.isArray(data?.payload?.items)) return data.payload.items;
  if (Array.isArray(data?.response?.data)) return data.response.data;
  if (Array.isArray(data?.response?.templates)) return data.response.templates;
  if (Array.isArray(data?.response?.items)) return data.response.items;

  return [];
}

function extractProviderTemplateId(tpl) {
  return String(
    deepPick(tpl, [
      "raw360.id",
      "raw360.templateId",
      "raw360.template_id",
      "raw360.data.id",
      "raw360.template.id",
      "id",
      "templateId",
      "template_id",
      "data.id",
      "template.id",
    ]) || ""
  ).trim();
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

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getJsonStruct(t = {}) {
  return (
    safeParseJson(t?.jsonstruct) ||
    safeParseJson(t?.template?.jsonstruct) ||
    safeParseJson(t?.data?.jsonstruct) ||
    safeParseJson(t?.raw360?.jsonstruct) ||
    safeParseJson(t?.raw360?.template?.jsonstruct) ||
    null
  );
}

function getSyntheticComponentsFromJsonStruct(t = {}) {
  const js = getJsonStruct(t);
  if (!js || typeof js !== "object") return [];

  const components = [];

  if (js.header) {
    components.push({
      type: "HEADER",
      format: String(js.header?.format || "").toUpperCase(),
      text: String(js.header?.text || ""),
    });
  }

  if (js.body) {
    components.push({
      type: "BODY",
      text: String(js.body?.text || ""),
    });
  }

  if (js.footer) {
    components.push({
      type: "FOOTER",
      text: String(js.footer?.text || ""),
    });
  }

  return components;
}

function pickComponents(t) {
  const candidates = [
    t?.components,
    t?.template?.components,
    t?.data?.components,
    t?.templateData?.components,
    t?.raw360?.components,
    t?.raw360?.template?.components,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }

  return getSyntheticComponentsFromJsonStruct(t);
}

function getComponentType(component = {}) {
  return String(
    deepPick(component, [
      "type",
      "componentType",
      "name",
      "component_type",
    ]) || ""
  )
    .trim()
    .toUpperCase();
}

function getComponentText(component = {}) {
  return String(
    deepPick(component, [
      "text",
      "body",
      "bodyText",
      "content.text",
      "componentData.text",
      "component_data.text",
      "data.text",
      "example.text",
    ]) || ""
  ).trim();
}

function getBodyFromTemplate(t = {}) {
  const direct = deepPick(t, [
    "body",
    "bodyText",
    "text",
    "template.body",
    "template.bodyText",
    "template.text",
    "data.body",
    "data.bodyText",
    "templateData.body",
    "templateData.bodyText",
    "raw360.body",
    "raw360.template.body",
  ]);

  if (direct != null && String(direct).trim()) {
    return String(direct).trim();
  }

  const js = getJsonStruct(t);
  const jsonBody = js?.body?.text;
  if (jsonBody != null && String(jsonBody).trim()) {
    return String(jsonBody).trim();
  }

  const components = pickComponents(t);
  const body = components.find((c) => getComponentType(c) === "BODY");
  return getComponentText(body);
}

function getFooterFromTemplate(t = {}) {
  const direct = deepPick(t, [
    "footer",
    "template.footer",
    "data.footer",
    "templateData.footer",
    "raw360.footer",
    "raw360.template.footer",
  ]);

  if (direct != null && String(direct).trim()) {
    return String(direct).trim();
  }

  const js = getJsonStruct(t);
  const jsonFooter = js?.footer?.text;
  if (jsonFooter != null && String(jsonFooter).trim()) {
    return String(jsonFooter).trim();
  }

  const components = pickComponents(t);
  const footer = components.find((c) => getComponentType(c) === "FOOTER");
  return getComponentText(footer);
}

function getHeaderMetaFromTemplate(t = {}) {
  const directFormat = String(
    deepPick(t, [
      "headerFormat",
      "header_format",
      "template.headerFormat",
      "template.header_format",
      "data.headerFormat",
      "data.header_format",
    ]) || ""
  )
    .trim()
    .toUpperCase();

  const directText = String(
    deepPick(t, [
      "headerText",
      "header_text",
      "template.headerText",
      "template.header_text",
      "data.headerText",
      "data.header_text",
    ]) || ""
  ).trim();

  if (directFormat || directText) {
    return {
      headerFormat: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(directFormat)
        ? directFormat
        : "",
      headerText: directText || "",
    };
  }

  const js = getJsonStruct(t);
  const jsFormat = String(js?.header?.format || "").trim().toUpperCase();
  const jsText = String(js?.header?.text || "").trim();

  if (jsFormat || jsText) {
    return {
      headerFormat: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(jsFormat)
        ? jsFormat
        : "",
      headerText: jsText || "",
    };
  }

  const components = pickComponents(t);
  const header = components.find((c) => getComponentType(c) === "HEADER");

  const format = String(
    deepPick(header, [
      "format",
      "headerFormat",
      "header_format",
      "componentData.format",
      "data.format",
    ]) || ""
  )
    .trim()
    .toUpperCase();

  const text = getComponentText(header);

  return {
    headerFormat: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(format) ? format : "",
    headerText: text || "",
  };
}

function getHeaderExampleFromTemplate(t = {}) {
  const components = pickComponents(t);
  const header = components.find((c) => getComponentType(c) === "HEADER");
  const ex = header?.example || header?.componentData?.example || header?.data?.example;

  if (!ex) return [];

  const h = ex?.header_handle ?? ex?.header_handles ?? ex?.HEADER_HANDLE ?? null;

  if (Array.isArray(h)) return h.filter(Boolean).map(String);
  if (typeof h === "string" && h.trim()) return [h.trim()];
  if (Array.isArray(ex)) return ex.filter(Boolean).map(String);

  return [];
}

function normalizeProviderError(err) {
  if (err?.data) {
    if (typeof err.data === "string") return { message: err.data };
    return err.data;
  }

  const data = err?.response?.data;
  if (data) {
    if (typeof data === "string") return { message: data };
    return data;
  }

  return { error: err?.message || "UNKNOWN_ERROR" };
}

/* ----------------------------------------
   ROUTES
----------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const [templates, latestSyncDoc] = await Promise.all([
      WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean(),
      WhatsAppTemplate.findOne({ syncedAt: { $ne: null } }).sort({ syncedAt: -1 }).lean(),
    ]);

    res.json({
      templates: templates || [],
      meta: {
        lastSyncAt: latestSyncDoc?.syncedAt || null,
        inSync: true,
      },
    });
  } catch (err) {
    console.error("LIST ERROR:", err);
    res.status(500).json({ success: false, error: "LIST_FAILED" });
  }
});

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

    const providerPayload = {
      name: cleanName,
      category: normalizeCategory(payload.category),
      language: normalizeLanguage(payload.language || "en"),
      components: payload.components,
    };

    let createResp = null;
    try {
      createResp = await tsRequest({
        method: "POST",
        path: TS_PATH_TEMPLATE_CREATE,
        data: providerPayload,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.warn("TrustSignal create template failed, saving locally only:", e?.message || e);
    }

    const body = getBodyFromTemplate(payload);
    const footer = getFooterFromTemplate(payload);
    const headerMeta = getHeaderMetaFromTemplate(payload);
    const headerExample = getHeaderExampleFromTemplate(payload);
    const providerTemplateId = extractProviderTemplateId(createResp?.data || payload);

    const doc = await WhatsAppTemplate.findOneAndUpdate(
      { name: cleanName },
      {
        $set: {
          name: cleanName,
          category: normalizeCategory(payload.category),
          language: normalizeLanguage(payload.language || "en"),

          template_id: providerTemplateId || "",
          templateId: providerTemplateId || "",
          providerTemplateId: providerTemplateId || "",

          body: body || "",
          footer: footer || "",
          components: pickComponents(payload) || [],
          status: "PENDING",
          rejectionReason: "",
          raw360: createResp?.data || {},
          lastSubmittedAt: new Date(),
          headerFormat: headerMeta.headerFormat || "",
          headerText: headerMeta.headerText || "",
          headerExampleHandles: headerExample || [],
        },
      },
      { upsert: true, new: true }
    ).lean();

    res.json({ success: true, template: doc });
  } catch (err) {
    console.error("CREATE ERROR:", err?.data || err);
    res.status(err?.status || 400).json({
      success: false,
      error: normalizeProviderError(err),
    });
  }
});

router.post("/sync", async (req, res) => {
  try {
    if (!TRUSTSIGNAL_API_KEY) {
      return res.status(400).json({
        success: false,
        error: {
          message: "TRUSTSIGNAL_API_KEY is missing in backend env",
        },
      });
    }

    const syncResp = await tsRequest({
      method: "GET",
      path: TS_PATH_TEMPLATE_LIST,
      params: {
        page: 1,
        limit: 100,
      },
    });

    const list = extractTemplateList(syncResp.data);

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          message: "TrustSignal returned success but no templates were extracted",
          usedEndpoint: TS_PATH_TEMPLATE_LIST,
          usedBase: syncResp?.base || "",
          rawKeys:
            syncResp?.data && typeof syncResp.data === "object"
              ? Object.keys(syncResp.data)
              : [],
          rawResponse: syncResp?.data || null,
        },
      });
    }

    const ops = [];
    const syncAt = new Date();

    for (const t of list) {
      const rawName = t?.name || t?.template?.name;
      if (!rawName) continue;

      const name = normalizeName(rawName);
      const status = pickStatus(t);
      const body = getBodyFromTemplate(t);
      const footer = getFooterFromTemplate(t);
      const headerMeta = getHeaderMetaFromTemplate(t);
      const headerExample = getHeaderExampleFromTemplate(t);
      const components = pickComponents(t);
      const providerTemplateId = extractProviderTemplateId(t);

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
              language: normalizeLanguage(
                t?.language ||
                  t?.lang ||
                  t?.template?.language ||
                  t?.template?.lang ||
                  "en"
              ),
              category: normalizeCategory(t?.category || t?.template?.category || ""),

              template_id: providerTemplateId || "",
              templateId: providerTemplateId || "",
              providerTemplateId: providerTemplateId || "",

              status,
              rejectionReason: String(rejectionReason || ""),
              body: body || "",
              footer: footer || "",
              components: components || [],
              raw360: t,
              syncedAt: syncAt,
              headerFormat: headerMeta.headerFormat || "",
              headerText: headerMeta.headerText || "",
              headerExampleHandles: headerExample || [],
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      await WhatsAppTemplate.bulkWrite(ops);
    }

    const templates = await WhatsAppTemplate.find({}).sort({ updatedAt: -1 }).lean();

    res.json({
      success: true,
      templates: templates || [],
      meta: {
        lastSyncAt: syncAt,
        inSync: true,
        pulledCount: list.length,
        upsertedCount: ops.length,
        usedEndpoint: TS_PATH_TEMPLATE_LIST,
        usedBase: syncResp?.base || "",
      },
    });
  } catch (err) {
    console.error("SYNC ERROR:", err?.data || err);
    res.status(err?.status || 500).json({
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
    console.error("DELETE ERROR:", err?.data || err);
    res.status(err?.status || 500).json({
      success: false, 
      error: normalizeProviderError(err),
    });
  }
});

module.exports = router;