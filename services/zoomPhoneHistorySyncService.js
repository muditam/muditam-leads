const axios = require("axios");
const ZoomCallLog = require("../models/ZoomCallLog");
const ZoomToken = require("../models/ZoomToken");
const Employee = require("../models/Employee");
const ZoomPhoneSyncRun = require("../models/ZoomPhoneSyncRun");
const { zoomPhoneS2SGet, hasS2SConfig } = require("./zoomS2SService");
const { getValidAccessTokenForUser } = require("./zoomAuthService");
const { broadcastManagerOverviewUpdate } = require("./callingManagerOverviewStream");

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function toPhone10(v = "") {
  return digitsOnly(v).slice(-10);
}

function normalizeText(v = "") {
  return String(v || "").trim().toLowerCase();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function toDateMaybe(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toZoomApiDate(v) {
  const d = v instanceof Date ? v : toDateMaybe(v);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function parseDurationToSec(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  const raw = String(v || "").trim();
  if (!raw || raw === "--") return 0;
  if (/^\d+$/.test(raw)) return Number(raw) || 0;
  const parts = raw.split(":").map((x) => Number(x));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0] || 0);
}

function deriveDirection(row = {}) {
  const d = normalizeText(firstNonEmpty(row.direction, row.event));
  if (d.includes("inbound") || d.includes("incoming")) return "inbound";
  if (d.includes("outbound") || d.includes("outgoing")) return "outbound";
  return "unknown";
}

function deriveOutcomeStatus(row = {}, durationSec = 0) {
  const result = normalizeText(firstNonEmpty(row.call_result, row.result, row.status, row.disposition));
  if (durationSec > 0 || result.includes("connected") || result.includes("answered")) {
    return { outcome: "answered", status: "completed" };
  }
  if (
    result.includes("missed") ||
    result.includes("abandoned") ||
    result.includes("no answer") ||
    result.includes("rejected") ||
    result.includes("failed") ||
    result.includes("canceled") ||
    result.includes("timeout")
  ) {
    return { outcome: "missed", status: "missed" };
  }
  return { outcome: "unknown", status: "updated" };
}

async function loadAgentMaps() {
  const [employees, tokens] = await Promise.all([
    Employee.find({ status: "active" }, { _id: 1, fullName: 1, email: 1, callerId: 1, agentNumber: 1 }).lean(),
    ZoomToken.find({}, { userId: 1, zoomUserId: 1, zoomEmail: 1 }).lean(),
  ]);

  const byId = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byZoomUserId = new Map();
  const byZoomEmail = new Map();

  for (const e of employees) {
    const id = String(e._id || "");
    if (!id) continue;
    byId.set(id, e);
    const email = normalizeText(e.email);
    if (email) byEmail.set(email, e);
    const c = toPhone10(e.callerId || "");
    const a = toPhone10(e.agentNumber || "");
    if (c) byPhone.set(c, e);
    if (a) byPhone.set(a, e);
  }

  for (const t of tokens) {
    const uid = String(t.userId || "");
    const e = byId.get(uid);
    if (!e) continue;
    const zid = normalizeText(t.zoomUserId || "");
    const zemail = normalizeText(t.zoomEmail || "");
    if (zid) byZoomUserId.set(zid, e);
    if (zemail) byZoomEmail.set(zemail, e);
  }

  return { byId, byEmail, byPhone, byZoomUserId, byZoomEmail };
}

function resolveAgent(row = {}, maps) {
  const direction = deriveDirection(row);

  const zoomUserId = normalizeText(firstNonEmpty(row.user_id, row.owner_id, row.zoom_user_id));
  if (zoomUserId && maps.byZoomUserId.has(zoomUserId)) return maps.byZoomUserId.get(zoomUserId);

  const fromEmail = normalizeText(firstNonEmpty(row.from_email, row.caller_email));
  const toEmail = normalizeText(firstNonEmpty(row.to_email, row.callee_email, row.user_email));
  if (direction === "outbound") {
    if (fromEmail && maps.byEmail.has(fromEmail)) return maps.byEmail.get(fromEmail);
    if (toEmail && maps.byEmail.has(toEmail)) return maps.byEmail.get(toEmail);
  } else if (direction === "inbound") {
    if (toEmail && maps.byEmail.has(toEmail)) return maps.byEmail.get(toEmail);
    if (fromEmail && maps.byEmail.has(fromEmail)) return maps.byEmail.get(fromEmail);
  }

  if (fromEmail && maps.byZoomEmail.has(fromEmail)) return maps.byZoomEmail.get(fromEmail);
  if (toEmail && maps.byZoomEmail.has(toEmail)) return maps.byZoomEmail.get(toEmail);

  const fromExt = toPhone10(firstNonEmpty(row.from_ext, row.caller_ext, row.extension));
  const toExt = toPhone10(firstNonEmpty(row.to_ext, row.callee_ext));
  if (fromExt && maps.byPhone.has(fromExt)) return maps.byPhone.get(fromExt);
  if (toExt && maps.byPhone.has(toExt)) return maps.byPhone.get(toExt);

  const caller10 = toPhone10(firstNonEmpty(row.caller_number, row.from_phone_number, row.from_number, row.phone_from));
  const callee10 = toPhone10(firstNonEmpty(row.callee_number, row.to_phone_number, row.to_number, row.phone_to));
  if (direction === "outbound") {
    if (caller10 && maps.byPhone.has(caller10)) return maps.byPhone.get(caller10);
    if (callee10 && maps.byPhone.has(callee10)) return maps.byPhone.get(callee10);
  } else if (direction === "inbound") {
    if (callee10 && maps.byPhone.has(callee10)) return maps.byPhone.get(callee10);
    if (caller10 && maps.byPhone.has(caller10)) return maps.byPhone.get(caller10);
  }

  if (caller10 && maps.byPhone.has(caller10)) return maps.byPhone.get(caller10);
  if (callee10 && maps.byPhone.has(callee10)) return maps.byPhone.get(callee10);

  return null;
}

function buildCanonicalCallId(row = {}) {
  const rawCallId = String(firstNonEmpty(row.call_id, row.id, row.call_log_id, row.callLogId) || "").trim();
  if (rawCallId) return rawCallId.replace(/^CID:/i, "");
  const hist = String(firstNonEmpty(row.call_history_uuid, row.callHistoryUuid) || "").trim();
  if (hist) return `history-${hist}`;
  const elem = String(firstNonEmpty(row.call_element_id, row.callElementId) || "").trim();
  if (elem) return `element-${elem}`;
  const start = String(firstNonEmpty(row.start_time, row.startTime, row.time) || "");
  const from = String(firstNonEmpty(row.from_phone_number, row.caller_number, row.from_number) || "");
  const to = String(firstNonEmpty(row.to_phone_number, row.callee_number, row.to_number) || "");
  return `hash-${Buffer.from(`${start}|${from}|${to}`).toString("base64").slice(0, 24)}`;
}

async function zoomPhoneUserGet(userId, path, params = {}) {
  const token = await getValidAccessTokenForUser(userId);
  const resp = await axios.get(`https://api.zoom.us/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 30000,
  });
  return resp.data || {};
}

async function upsertCallHistoryRows(rows, { maps, mode, metadataExtra = {} }) {
  let upserts = 0;
  let inserts = 0;
  let updates = 0;
  let unresolvedAgentRows = 0;

  for (const row of rows) {
    const callId = buildCanonicalCallId(row);
    const direction = deriveDirection(row);
    const durationSec = parseDurationToSec(firstNonEmpty(row.duration, row.call_duration, row.talk_time));
    const { outcome, status } = deriveOutcomeStatus(row, durationSec);
    const startTime = toDateMaybe(firstNonEmpty(row.start_time, row.startTime, row.time));
    const endTime = toDateMaybe(firstNonEmpty(row.end_time, row.endTime));
    const callHistoryUuid = String(firstNonEmpty(row.call_history_uuid, row.callHistoryUuid) || "");
    const callElementId = String(firstNonEmpty(row.call_element_id, row.callElementId) || "");
    const callElementIds = Array.isArray(row.call_elements)
      ? row.call_elements.map((x) => String(firstNonEmpty(x?.call_element_id, x?.id) || "")).filter(Boolean)
      : [];

    const agent = resolveAgent(row, maps);
    if (!agent) unresolvedAgentRows += 1;

    const callerNumber = String(firstNonEmpty(row.caller_number, row.from_phone_number, row.from_number) || "").trim();
    const calleeNumber = String(firstNonEmpty(row.callee_number, row.to_phone_number, row.to_number) || "").trim();

    const updateDoc = {
      callHistoryUuid,
      callElementId,
      callElementIds,
      agentId: agent?._id || null,
      zoomUserId: String(firstNonEmpty(row.user_id, row.owner_id, row.zoom_user_id) || ""),
      direction,
      outcome,
      status,
      phoneNumber: direction === "outbound" ? calleeNumber : callerNumber,
      callerNumber,
      calleeNumber,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      duration: durationSec,
      eventType: "call_history_sync",
      metadata: {
        ...(row || {}),
        ...metadataExtra,
        syncMode: mode,
      },
    };

    const existing = await ZoomCallLog.findOne({ callId }).select("_id").lean();
    await ZoomCallLog.findOneAndUpdate(
      { callId },
      { $set: updateDoc, $setOnInsert: { callId } },
      { upsert: true, new: false }
    );

    upserts += 1;
    if (existing?._id) updates += 1;
    else inserts += 1;
  }

  return {
    upserts,
    inserts,
    updates,
    unresolvedAgentRows,
  };
}

async function syncCallHistoryWindow({ from, to, mode = "incremental", pageSize = 100 }) {
  if (!hasS2SConfig()) {
    throw new Error("Zoom S2S not configured");
  }
  const run = await ZoomPhoneSyncRun.create({ mode, from, to, status: "running" });

  const maps = await loadAgentMaps();

  let nextPageToken = "";
  let pagesFetched = 0;
  let apiRows = 0;
  let upserts = 0;
  let inserts = 0;
  let updates = 0;
  let unresolvedAgentRows = 0;

  try {
    do {
      const data = await zoomPhoneS2SGet("/phone/call_history", {
        from: toZoomApiDate(from),
        to: toZoomApiDate(to),
        page_size: pageSize,
        next_page_token: nextPageToken || undefined,
      });

      const rows = Array.isArray(data.call_history) ? data.call_history : [];
      apiRows += rows.length;
      pagesFetched += 1;
      const result = await upsertCallHistoryRows(rows, {
        maps,
        mode,
        metadataExtra: { source: "zoom_call_history_api" },
      });
      upserts += result.upserts;
      inserts += result.inserts;
      updates += result.updates;
      unresolvedAgentRows += result.unresolvedAgentRows;

      nextPageToken = String(data.next_page_token || "");
    } while (nextPageToken);

    run.status = "ok";
    run.finishedAt = new Date();
    run.pagesFetched = pagesFetched;
    run.apiRows = apiRows;
    run.upserts = upserts;
    run.inserts = inserts;
    run.updates = updates;
    run.unresolvedAgentRows = unresolvedAgentRows;
    await run.save();

    await broadcastManagerOverviewUpdate();

    return {
      ok: true,
      from,
      to,
      mode,
      pagesFetched,
      apiRows,
      upserts,
      inserts,
      updates,
      unresolvedAgentRows,
    };
  } catch (err) {
    run.status = "failed";
    run.finishedAt = new Date();
    run.pagesFetched = pagesFetched;
    run.apiRows = apiRows;
    run.upserts = upserts;
    run.inserts = inserts;
    run.updates = updates;
    run.unresolvedAgentRows = unresolvedAgentRows;
    run.syncErrors = [String(err?.response?.data?.message || err.message || err)];
    await run.save();
    throw err;
  }
}

async function syncCallHistoryWindowViaConnectedUsers({ from, to, pageSize = 100 }) {
  const run = await ZoomPhoneSyncRun.create({
    mode: "manual",
    from,
    to,
    status: "running",
    notes: { source: "oauth_fallback" },
  });

  const maps = await loadAgentMaps();
  const tokens = await ZoomToken.find({}, { userId: 1 }).lean();
  const userIds = Array.from(new Set(tokens.map((t) => String(t.userId || "").trim()).filter(Boolean)));

  let pagesFetched = 0;
  let apiRows = 0;
  let upserts = 0;
  let inserts = 0;
  let updates = 0;
  let unresolvedAgentRows = 0;
  const syncErrors = [];

  try {
    if (!userIds.length) {
      throw new Error("No Zoom users connected for manager fallback sync");
    }

    for (const userId of userIds) {
      let nextPageToken = "";

      try {
        do {
          const data = await zoomPhoneUserGet(userId, "/phone/call_history", {
            from: toZoomApiDate(from),
            to: toZoomApiDate(to),
            page_size: pageSize,
            next_page_token: nextPageToken || undefined,
          });

          const rows = Array.isArray(data.call_history) ? data.call_history : [];
          apiRows += rows.length;
          pagesFetched += 1;

          const result = await upsertCallHistoryRows(rows, {
            maps,
            mode: "oauth_fallback",
            metadataExtra: {
              source: "zoom_call_history_user_api",
              syncedForUserId: userId,
            },
          });
          upserts += result.upserts;
          inserts += result.inserts;
          updates += result.updates;
          unresolvedAgentRows += result.unresolvedAgentRows;

          nextPageToken = String(data.next_page_token || "");
        } while (nextPageToken);
      } catch (err) {
        syncErrors.push(
          `user:${userId} ${String(err?.response?.data?.message || err.message || err)}`
        );
      }
    }

    if (upserts === 0 && syncErrors.length) {
      throw new Error(syncErrors[0]);
    }

    run.status = "ok";
    run.finishedAt = new Date();
    run.pagesFetched = pagesFetched;
    run.apiRows = apiRows;
    run.upserts = upserts;
    run.inserts = inserts;
    run.updates = updates;
    run.unresolvedAgentRows = unresolvedAgentRows;
    run.syncErrors = syncErrors;
    await run.save();

    if (upserts > 0) {
      await broadcastManagerOverviewUpdate();
    }

    return {
      ok: true,
      from,
      to,
      mode: "oauth_fallback",
      usersScanned: userIds.length,
      pagesFetched,
      apiRows,
      upserts,
      inserts,
      updates,
      unresolvedAgentRows,
      syncErrors,
    };
  } catch (err) {
    run.status = "failed";
    run.finishedAt = new Date();
    run.pagesFetched = pagesFetched;
    run.apiRows = apiRows;
    run.upserts = upserts;
    run.inserts = inserts;
    run.updates = updates;
    run.unresolvedAgentRows = unresolvedAgentRows;
    run.syncErrors = syncErrors.length
      ? syncErrors
      : [String(err?.response?.data?.message || err.message || err)];
    await run.save();
    throw err;
  }
}

async function runIncrementalSync(hours = 6) {
  const to = new Date();
  const from = new Date(Date.now() - hours * 60 * 60 * 1000);
  return syncCallHistoryWindow({ from, to, mode: "incremental", pageSize: 100 });
}

async function runNightlyReconcile(days = 45) {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return syncCallHistoryWindow({ from, to, mode: "nightly", pageSize: 100 });
}

async function getSyncDiagnostics({ from, to }) {
  const fromDate = toDateMaybe(from) || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const toDate = toDateMaybe(to) || new Date();

  const canonicalCount = await ZoomCallLog.countDocuments({
    $or: [
      { startTime: { $gte: fromDate, $lte: toDate } },
      { startTime: { $exists: false }, createdAt: { $gte: fromDate, $lte: toDate } },
      { startTime: null, createdAt: { $gte: fromDate, $lte: toDate } },
    ],
  });

  const lastRun = await ZoomPhoneSyncRun.findOne({}).sort({ createdAt: -1 }).lean();

  return {
    from: fromDate,
    to: toDate,
    canonicalCount,
    lastSyncRun: lastRun || null,
    s2sConfigured: hasS2SConfig(),
  };
}

module.exports = {
  syncCallHistoryWindow,
  syncCallHistoryWindowViaConnectedUsers,
  runIncrementalSync,
  runNightlyReconcile,
  getSyncDiagnostics,
};
