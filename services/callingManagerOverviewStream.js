const ZoomCallLog = require("../models/ZoomCallLog");
const Employee = require("../models/Employee");
const ZoomToken = require("../models/ZoomToken");

const MANAGER_OVERVIEW_EVENT = "manager_overview_update";
const clients = new Set();

function getDateRange(range = {}) {
  const now = new Date();
  const preset = String(range?.preset || "").toLowerCase();

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const mondayStart = (d) => {
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const x = new Date(d);
    x.setDate(d.getDate() + diff);
    return startOfDay(x);
  };

  if (preset === "today") return { start: startOfDay(now), end: now };
  if (preset === "yesterday") {
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    return { start: startOfDay(y), end: endOfDay(y) };
  }
  if (preset === "this_week") return { start: mondayStart(now), end: now };
  if (preset === "last_week") {
    const thisWeekStart = mondayStart(now);
    const lastWeekEnd = new Date(thisWeekStart.getTime() - 1);
    const lastWeekStart = new Date(lastWeekEnd);
    lastWeekStart.setDate(lastWeekEnd.getDate() - 6);
    return { start: startOfDay(lastWeekStart), end: endOfDay(lastWeekEnd) };
  }
  if (preset === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now };
  }
  if (preset === "last_month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start, end };
  }

  const startRaw = range?.start ? new Date(range.start) : null;
  const endRaw = range?.end ? new Date(range.end) : null;
  if (startRaw && endRaw && !Number.isNaN(startRaw.getTime()) && !Number.isNaN(endRaw.getTime())) {
    return { start: startRaw, end: endRaw };
  }

  return { start: new Date(Date.now() - 24 * 60 * 60 * 1000), end: now };
}

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function toPhone10(v = "") {
  return digitsOnly(v).slice(-10);
}

function norm(v = "") {
  return String(v || "").trim().toLowerCase();
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

function getMeta(row, key) {
  return row?.metadata?.[key];
}

function isAnswered(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const outcome = String(row.outcome || "").toLowerCase();
  const recStatus = String(row.recordingStatus || "").toLowerCase();
  const hasTranscript = String(row.transcriptContent || "").trim().length > 0;
  return (
    Number(row.duration || 0) > 0 ||
    outcome === "answered" ||
    status === "connected" ||
    status === "completed" ||
    status === "ended" ||
    recStatus === "completed" ||
    hasTranscript
  );
}

async function buildManagerOverview(range = {}) {
  const { start, end } = getDateRange(range);
  const rows = await ZoomCallLog.find({
    $or: [
      { startTime: { $gte: start, $lte: end } },
      { startTime: { $exists: false }, createdAt: { $gte: start, $lte: end } },
      { startTime: null, createdAt: { $gte: start, $lte: end } },
    ],
  }).lean();

  const total = rows.length;
  const answered = rows.filter((r) => isAnswered(r)).length;
  const missed = total - answered;
  const totalDuration = rows.reduce((sum, row) => sum + Number(row.duration || 0), 0);
  const avgDuration = total ? Math.round(totalDuration / total) : 0;
  const incoming = rows.filter((r) => String(r.direction || "").toLowerCase() === "inbound").length;
  const outgoing = rows.filter((r) => String(r.direction || "").toLowerCase() === "outbound").length;
  const answeredRate = total ? Number(((answered / total) * 100).toFixed(2)) : 0;

  const employees = await Employee.find(
    { status: "active" },
    { _id: 1, fullName: 1, callerId: 1, agentNumber: 1, email: 1 }
  ).lean();
  const zoomTokens = await ZoomToken.find({}, { userId: 1, zoomUserId: 1 }).lean();
  const byId = new Map(employees.map((e) => [String(e._id), e.fullName || String(e._id)]));
  const byPhone10 = new Map();
  const byZoomUserId = new Map();
  for (const t of zoomTokens) {
    const k = String(t.zoomUserId || "").trim();
    const uid = String(t.userId || "").trim();
    if (k && uid) byZoomUserId.set(k, uid);
  }
  for (const e of employees) {
    const phoneA = toPhone10(e.callerId || "");
    const phoneB = toPhone10(e.agentNumber || "");
    if (phoneA) byPhone10.set(phoneA, e);
    if (phoneB) byPhone10.set(phoneB, e);
  }

  const perAgentMap = {};
  const byResult = {};
  const byStatus = {};
  const byDirection = {};
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0, answered: 0, missed: 0 }));
  const byDevice = {};
  const bySite = {};
  const voicemailStats = { yes: 0, no: 0, unknown: 0 };
  const recordedStats = { yes: 0, no: 0, unknown: 0 };
  const waitTime = { totalSec: 0, samples: 0, avgSec: 0 };
  const topDestinations = {};
  const topSources = {};

  for (const row of rows) {
    const wasAnswered = isAnswered(row);

    const resultRaw = String(
      getMeta(row, "call_result") ||
      getMeta(row, "Call Result") ||
      row.outcome ||
      "unknown"
    ).trim();
    const resultKey = resultRaw || "unknown";
    byResult[resultKey] = (byResult[resultKey] || 0) + 1;

    const statusKey = String(row.status || "unknown").trim() || "unknown";
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;

    const dirKey = String(row.direction || "unknown").trim() || "unknown";
    byDirection[dirKey] = (byDirection[dirKey] || 0) + 1;

    const ts = row.startTime ? new Date(row.startTime) : row.createdAt ? new Date(row.createdAt) : null;
    if (ts && !Number.isNaN(ts.getTime())) {
      const h = ts.getHours();
      if (byHour[h]) {
        byHour[h].calls += 1;
        if (wasAnswered) byHour[h].answered += 1;
        else byHour[h].missed += 1;
      }
    }

    const device = String(getMeta(row, "device") || getMeta(row, "Device") || "Unknown").trim() || "Unknown";
    byDevice[device] = (byDevice[device] || 0) + 1;

    const site = String(getMeta(row, "site") || getMeta(row, "Site") || "Unknown").trim() || "Unknown";
    bySite[site] = (bySite[site] || 0) + 1;

    const voicemail = norm(getMeta(row, "voicemail") || getMeta(row, "Voicemail"));
    if (!voicemail || voicemail === "--") voicemailStats.unknown += 1;
    else if (["y", "yes", "true"].includes(voicemail)) voicemailStats.yes += 1;
    else voicemailStats.no += 1;

    const recorded = norm(getMeta(row, "recorded") || getMeta(row, "Recorded"));
    if (!recorded || recorded === "--") recordedStats.unknown += 1;
    else if (["y", "yes", "true"].includes(recorded)) recordedStats.yes += 1;
    else recordedStats.no += 1;

    const waitRaw = getMeta(row, "wait_time") ?? getMeta(row, "Wait Time");
    const waitSec = parseDurationToSec(waitRaw);
    if (waitSec > 0) {
      waitTime.totalSec += waitSec;
      waitTime.samples += 1;
    }

    const toNum = toPhone10(row.calleeNumber || getMeta(row, "to_phone_number") || getMeta(row, "To Phone Number") || "");
    const fromNum = toPhone10(row.callerNumber || getMeta(row, "from_phone_number") || getMeta(row, "From Phone Number") || "");
    if (toNum) topDestinations[toNum] = (topDestinations[toNum] || 0) + 1;
    if (fromNum) topSources[fromNum] = (topSources[fromNum] || 0) + 1;

    let key = String(row.agentId || "");
    let name = key ? byId.get(key) || key : "";

    if (!key) {
      const uid = byZoomUserId.get(String(row.zoomUserId || "").trim());
      if (uid) {
        key = uid;
        name = byId.get(uid) || uid;
      }
    }

    if (!key) {
      const phoneKeyA = toPhone10(row.callerNumber || "");
      const phoneKeyB = toPhone10(row.calleeNumber || "");
      const match = byPhone10.get(phoneKeyA) || byPhone10.get(phoneKeyB) || null;
      if (match?._id) {
        key = String(match._id);
        name = match.fullName || key;
      }
    }

    if (!key) {
      key = "unassigned";
      name = "unassigned";
    }

    if (!perAgentMap[key]) {
      perAgentMap[key] = {
        agentId: key,
        agentName: name || key,
        calls: 0,
        answered: 0,
        missed: 0,
        duration: 0,
        incoming: 0,
        outgoing: 0,
      };
    }
    perAgentMap[key].calls += 1;
    perAgentMap[key].duration += Number(row.duration || 0);
    if (String(row.direction || "").toLowerCase() === "inbound") perAgentMap[key].incoming += 1;
    if (String(row.direction || "").toLowerCase() === "outbound") perAgentMap[key].outgoing += 1;
    if (wasAnswered) perAgentMap[key].answered += 1;
    else perAgentMap[key].missed += 1;
  }

  waitTime.avgSec = waitTime.samples ? Math.round(waitTime.totalSec / waitTime.samples) : 0;

  const perAgent = Object.values(perAgentMap).map((a) => ({
    ...a,
    avgDuration: a.calls ? Math.round(a.duration / a.calls) : 0,
    answerRate: a.calls ? Number(((a.answered / a.calls) * 100).toFixed(2)) : 0,
  })).sort((a, b) => b.calls - a.calls);

  const topResults = Object.entries(byResult)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const statusBreakdown = Object.entries(byStatus)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const directionBreakdown = Object.entries(byDirection)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const deviceBreakdown = Object.entries(byDevice)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const siteBreakdown = Object.entries(bySite)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const topRepeatDestinations = Object.entries(topDestinations)
    .map(([phone, count]) => ({ phone, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const topRepeatSources = Object.entries(topSources)
    .map(([phone, count]) => ({ phone, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    total,
    answered,
    missed,
    answeredRate,
    avgDuration,
    totalDuration,
    incoming,
    outgoing,
    waitTime,
    voicemailStats,
    recordedStats,
    topResults,
    statusBreakdown,
    directionBreakdown,
    byHour,
    deviceBreakdown,
    siteBreakdown,
    topRepeatDestinations,
    topRepeatSources,
    range: { start, end },
    perAgent,
  };
}

function addManagerOverviewClient(res, range = {}) {
  clients.add({ res, range });
}

function removeManagerOverviewClient(res) {
  for (const c of Array.from(clients)) {
    if (c.res === res) clients.delete(c);
  }
}

function writeManagerEvent(res, payload) {
  try {
    res.write(`event: ${MANAGER_OVERVIEW_EVENT}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

async function broadcastManagerOverviewUpdate() {
  if (!clients.size) return;
  const cache = new Map();
  for (const c of Array.from(clients)) {
    const key = JSON.stringify(c.range || {});
    let payload = cache.get(key);
    if (!payload) {
      payload = await buildManagerOverview(c.range || {});
      cache.set(key, payload);
    }
    const ok = writeManagerEvent(c.res, payload);
    if (!ok) clients.delete(c);
  }
}

module.exports = {
  MANAGER_OVERVIEW_EVENT,
  addManagerOverviewClient,
  removeManagerOverviewClient,
  buildManagerOverview,
  broadcastManagerOverviewUpdate,
};
