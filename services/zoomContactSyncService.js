const crypto = require("crypto");
const axios = require("axios");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const ZoomToken = require("../models/ZoomToken");
const ZoomContactSync = require("../models/ZoomContactSync");
const { getValidAccessTokenForUser } = require("./zoomAuthService");

const REQUIRED_CONTACT_SCOPES = [
  "phone:write:admin",
  "phone:read:admin",
];

const queue = [];
const inQueue = new Set();
let workerRunning = false;
let fullSyncRunning = false;
let lastFullSyncAt = null;
let lastFullSyncError = "";

const metrics = {
  processed: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  rateLimited: 0,
};

const normalizeDigits = (v = "") => String(v || "").replace(/\D/g, "");

function normalizeIndianE164(raw) {
  const d = normalizeDigits(raw);
  if (!d) return "";
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length > 10) return `+${d}`;
  return "";
}

function contactHash(name, phoneE164) {
  const payload = `${String(name || "").trim().toLowerCase()}|${String(phoneE164 || "").trim()}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasContactScopes(scopes = []) {
  const set = new Set((scopes || []).map((s) => String(s || "").trim()));
  const hasWrite = set.has("phone:write:admin") || set.has("phone:write:external_contact:admin");
  const hasRead = set.has("phone:read:admin") || set.has("phone:read:external_contact:admin");
  return hasRead && hasWrite;
}

async function zoomApi({ token, method, url, data, params, retries = 3 }) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const resp = await axios({
        method,
        url: `https://api.zoom.us/v2${url}`,
        data,
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 25000,
      });
      return resp.data;
    } catch (err) {
      const status = Number(err?.response?.status || 0);
      if (status === 429) {
        metrics.rateLimited += 1;
        const retryAfterSec = Number(err?.response?.headers?.["retry-after"] || 1);
        await sleep(Math.max(1000, retryAfterSec * 1000));
        attempt += 1;
        continue;
      }
      if (status >= 500 && status < 600 && attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Zoom API retries exhausted");
}

async function findExternalContactIdByPhone(token, phoneE164) {
  let pageNumber = 1;
  const pageSize = 100;
  while (true) {
    const data = await zoomApi({
      token,
      method: "GET",
      url: "/phone/external_contacts",
      params: { page_size: pageSize, page_number: pageNumber },
    });
    const list = data?.external_contacts || [];
    for (const c of list) {
      const nums = c?.phone_numbers || [];
      const found = nums.some((n) => normalizeIndianE164(n?.number || n) === phoneE164);
      if (found) return String(c?.id || "");
    }
    if (!list.length || list.length < pageSize) break;
    pageNumber += 1;
    if (pageNumber > 20) break;
  }
  return "";
}

async function upsertOneForUser({ tokenRecord, name, phoneE164, source }) {
  const userId = tokenRecord.userId;
  const zoomUserId = tokenRecord.zoomUserId || "";
  const hash = contactHash(name, phoneE164);
  const key = phoneE164;

  let row = await ZoomContactSync.findOne({ userId, lmsContactKey: key });
  if (row && row.lastHash === hash && row.status === "synced") {
    metrics.skipped += 1;
    return { status: "skipped" };
  }

  if (!hasContactScopes(tokenRecord.scopes || [])) {
    if (!row) row = new ZoomContactSync({ userId, zoomUserId, lmsContactKey: key });
    row.status = "blocked_scope";
    row.lastError = "Missing Zoom contact scopes. Reconnect Zoom app with contact read/write scopes.";
    row.displayName = name;
    row.source = source;
    row.retryCount = (row.retryCount || 0) + 1;
    await row.save();
    metrics.failed += 1;
    return { status: "blocked_scope" };
  }

  const token = await getValidAccessTokenForUser(userId);
  const payload = {
    first_name: String(name || "Unknown").trim().slice(0, 63),
    phone_numbers: [{ number: phoneE164, label: "mobile" }],
    notes: `LMS Auto Sync (${source})`,
  };

  try {
    let zoomContactId = row?.zoomContactId || "";

    if (!zoomContactId) {
      zoomContactId = await findExternalContactIdByPhone(token, phoneE164);
    }

    if (zoomContactId) {
      await zoomApi({
        token,
        method: "PATCH",
        url: `/phone/external_contacts/${encodeURIComponent(zoomContactId)}`,
        data: payload,
      });
      metrics.updated += 1;
    } else {
      const created = await zoomApi({
        token,
        method: "POST",
        url: "/phone/external_contacts",
        data: payload,
      });
      zoomContactId = String(created?.id || "");
      metrics.created += 1;
    }

    await ZoomContactSync.findOneAndUpdate(
      { userId, lmsContactKey: key },
      {
        userId,
        zoomUserId,
        lmsContactKey: key,
        zoomContactId,
        displayName: name,
        source,
        lastHash: hash,
        lastSyncedAt: new Date(),
        lastError: "",
        status: "synced",
        retryCount: 0,
      },
      { upsert: true, new: true }
    );
    metrics.processed += 1;
    return { status: zoomContactId ? "synced" : "failed" };
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || "Zoom sync failed";
    await ZoomContactSync.findOneAndUpdate(
      { userId, lmsContactKey: key },
      {
        userId,
        zoomUserId,
        lmsContactKey: key,
        displayName: name,
        source,
        lastError: msg,
        status: "failed",
        $inc: { retryCount: 1 },
      },
      { upsert: true, new: true }
    );
    metrics.failed += 1;
    return { status: "failed", error: msg };
  }
}

async function processJob(job) {
  const name = String(job?.name || "").trim() || "Unknown";
  const phoneE164 = normalizeIndianE164(job?.phone || "");
  if (!phoneE164) return;
  const source = String(job?.source || "Unknown");

  const tokens = await ZoomToken.find({}).lean();
  for (const tokenRecord of tokens) {
    await upsertOneForUser({ tokenRecord, name, phoneE164, source });
  }
}

async function workerLoop() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const key = `${job.name}|${job.phone}`;
      inQueue.delete(key);
      try {
        await processJob(job);
      } catch (err) {
        metrics.failed += 1;
      }
      await sleep(60);
    }
  } finally {
    workerRunning = false;
  }
}

function enqueueContact({ name, phone, source }) {
  const p = normalizeIndianE164(phone);
  if (!p) return false;
  const key = `${String(name || "").trim()}|${p}`;
  if (inQueue.has(key)) return false;
  inQueue.add(key);
  queue.push({ name: String(name || "").trim() || "Unknown", phone: p, source: source || "Unknown" });
  setImmediate(() => workerLoop().catch(() => {}));
  return true;
}

async function gatherUnifiedContacts(limit = 50000) {
  const [leads, customers] = await Promise.all([
    Lead.find({}, { name: 1, contactNumber: 1, _id: 1 }).sort({ _id: -1 }).limit(limit).lean(),
    Customer.find({}, { name: 1, phone: 1, _id: 1 }).sort({ _id: -1 }).limit(limit).lean(),
  ]);

  const merged = [
    ...leads.map((x) => ({ name: x?.name || "", phone: x?.contactNumber || "", source: "Lead" })),
    ...customers.map((x) => ({ name: x?.name || "", phone: x?.phone || "", source: "Customer" })),
  ];

  const byPhone = new Map();
  for (const row of merged) {
    const phoneE164 = normalizeIndianE164(row.phone);
    if (!phoneE164) continue;
    const name = String(row.name || "").trim() || "Unknown";
    if (!byPhone.has(phoneE164)) {
      byPhone.set(phoneE164, { name, phoneE164, source: row.source });
      continue;
    }
    const prev = byPhone.get(phoneE164);
    if (String(prev.name || "").toLowerCase() === "unknown" && String(name).toLowerCase() !== "unknown") {
      byPhone.set(phoneE164, { name, phoneE164, source: row.source });
    }
  }
  return Array.from(byPhone.values());
}

async function runFullSync() {
  if (fullSyncRunning) return { ok: true, skipped: true, reason: "already_running" };
  fullSyncRunning = true;
  lastFullSyncError = "";
  try {
    const contacts = await gatherUnifiedContacts(50000);
    for (const c of contacts) {
      enqueueContact({ name: c.name, phone: c.phoneE164, source: c.source });
    }
    lastFullSyncAt = new Date();
    return { ok: true, queued: contacts.length };
  } catch (err) {
    lastFullSyncError = err.message || "full sync failed";
    return { ok: false, message: lastFullSyncError };
  } finally {
    fullSyncRunning = false;
  }
}

async function getFailures(limit = 100) {
  return ZoomContactSync.find({ status: { $in: ["failed", "blocked_scope"] } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();
}

async function getStatusSummary() {
  const [totalMappings, failedMappings, blockedMappings] = await Promise.all([
    ZoomContactSync.countDocuments({}),
    ZoomContactSync.countDocuments({ status: "failed" }),
    ZoomContactSync.countDocuments({ status: "blocked_scope" }),
  ]);
  return {
    queueSize: queue.length,
    workerRunning,
    fullSyncRunning,
    lastFullSyncAt,
    lastFullSyncError,
    totalMappings,
    failedMappings,
    blockedMappings,
    metrics: { ...metrics },
    requiredScopes: REQUIRED_CONTACT_SCOPES,
  };
}

module.exports = {
  REQUIRED_CONTACT_SCOPES,
  normalizeIndianE164,
  contactHash,
  hasContactScopes,
  enqueueContact,
  runFullSync,
  getFailures,
  getStatusSummary,
};
