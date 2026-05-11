const express = require("express");
const axios = require("axios");
const requireSession = require("../middleware/requireSession");
const ZoomCallLog = require("../models/ZoomCallLog");
const { getUserIdFromReq, getValidAccessTokenForUser } = require("../services/zoomAuthService");
const { isManagerRole, normalizeRole } = require("../utils/managerRoles");
const {
  syncCallHistoryWindow,
  syncCallHistoryWindowViaConnectedUsers,
  runIncrementalSync,
  getSyncDiagnostics,
} = require("../services/zoomPhoneHistorySyncService");
const { hasS2SConfig } = require("../services/zoomS2SService");
const {
  MANAGER_OVERVIEW_EVENT,
  addManagerOverviewClient,
  removeManagerOverviewClient,
  buildManagerOverview,
} = require("../services/callingManagerOverviewStream");

const router = express.Router();

function getOverviewRangeFromQuery(query = {}) {
  const preset = String(query.preset || "").trim().toLowerCase();
  const start = String(query.start || "").trim();
  const end = String(query.end || "").trim();
  return { preset, start, end };
}

async function zoomPhoneGet(userId, url, params = {}) {
  const token = await getValidAccessTokenForUser(userId);
  const resp = await axios.get(`https://api.zoom.us/v2${url}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 20000,
  });
  return resp.data || {};
}

function getDisplayPhone(row = {}) {
  return String(
    row.phoneNumber ||
    row.callerNumber ||
    row.calleeNumber ||
    row.metadata?.phone_number ||
    row.metadata?.caller_number ||
    row.metadata?.callee_number ||
    row.metadata?.from_phone_number ||
    row.metadata?.to_phone_number ||
    row.metadata?.from_number ||
    row.metadata?.to_number ||
    ""
  ).trim();
}

function getDisplayCaller(row = {}) {
  return String(
    row.callerNumber ||
    row.metadata?.caller_number ||
    row.metadata?.from_phone_number ||
    row.metadata?.from_number ||
    ""
  ).trim();
}

function getDisplayCallee(row = {}) {
  return String(
    row.calleeNumber ||
    row.metadata?.callee_number ||
    row.metadata?.to_phone_number ||
    row.metadata?.to_number ||
    ""
  ).trim();
}

router.get("/", requireSession, async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
  const q = String(req.query.q || "").trim();
  const agentId = String(req.query.agentId || "");

  const role = req.sessionUser?.role || "";
  const myId = String(getUserIdFromReq(req) || "");
  const filter = {};

  if (!isManagerRole(role)) filter.agentId = myId;
  if (isManagerRole(role) && agentId) filter.agentId = agentId;
  if (q) {
    filter.$or = [
      { phoneNumber: { $regex: q, $options: "i" } },
      { callerNumber: { $regex: q, $options: "i" } },
      { calleeNumber: { $regex: q, $options: "i" } },
      { transcriptContent: { $regex: q, $options: "i" } },
      { notes: { $regex: q, $options: "i" } },
    ];
  }

  const [rows, total] = await Promise.all([
    ZoomCallLog.find(filter).sort({ startTime: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ZoomCallLog.countDocuments(filter),
  ]);

  res.json({
    rows: rows.map((row) => ({
      ...row,
      displayPhone: getDisplayPhone(row),
      displayCaller: getDisplayCaller(row),
      displayCallee: getDisplayCallee(row),
    })),
    total,
    page,
    limit,
  });
});

router.get("/history", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size || 30)));
    const nextPageToken = String(req.query.next_page_token || "");
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    const data = await zoomPhoneGet(userId, "/phone/call_history", {
      page_size: pageSize,
      next_page_token: nextPageToken || undefined,
      from: from || undefined,
      to: to || undefined,
    });

    const rows = Array.isArray(data.call_history) ? data.call_history : [];
    return res.json({
      rows,
      next_page_token: data.next_page_token || "",
      page_size: data.page_size || pageSize,
      total_records: data.total_records || rows.length,
    });
  } catch (err) {
    return res.status(400).json({ message: err.response?.data?.message || err.message || "Failed to fetch call history" });
  }
});

router.get("/history/:callHistoryUuid", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    const callHistoryUuid = String(req.params.callHistoryUuid || "");
    const data = await zoomPhoneGet(userId, `/phone/call_history/${encodeURIComponent(callHistoryUuid)}`);
    return res.json({
      call_id: data.call_id || "",
      call_history_uuid: data.call_history_uuid || callHistoryUuid,
      call_elements: Array.isArray(data.call_elements) ? data.call_elements : [],
      raw: data,
    });
  } catch (err) {
    return res.status(400).json({ message: err.response?.data?.message || err.message || "Failed to fetch call history detail" });
  }
});

router.get("/element/:callElementId", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    const callElementId = String(req.params.callElementId || "");
    const data = await zoomPhoneGet(userId, `/phone/call_element/${encodeURIComponent(callElementId)}`);
    return res.json(data);
  } catch (err) {
    return res.status(400).json({ message: err.response?.data?.message || err.message || "Failed to fetch call element" });
  }
});

router.get("/manager/overview", requireSession, async (req, res) => {
  try {
    const role = req.sessionUser?.role || "";
    if (!isManagerRole(role)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[calling-center] manager overview forbidden", {
          userId: String(getUserIdFromReq(req) || ""),
          normalizedRole: normalizeRole(role),
        });
      }
      return res.status(403).json({ message: "Forbidden" });
    }

    const range = getOverviewRangeFromQuery(req.query);
    let overview = await buildManagerOverview(range);
    const shouldWarmFromZoom = Number(overview?.total || 0) === 0;

    if (shouldWarmFromZoom) {
      try {
        const from = overview?.range?.start ? new Date(overview.range.start) : null;
        const to = overview?.range?.end ? new Date(overview.range.end) : null;
        if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
          if (hasS2SConfig()) {
            await syncCallHistoryWindow({ from, to, mode: "manual", pageSize: 100 });
          } else {
            await syncCallHistoryWindowViaConnectedUsers({ from, to, pageSize: 100 });
          }
          overview = await buildManagerOverview(range);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[calling-center] on-demand manager sync failed", err.message || err);
        }
      }
    }

    return res.json(overview);
  } catch (err) {
    return res.status(500).json({ message: err.message || "Failed to build manager overview" });
  }
});

router.get("/manager/diagnostics", requireSession, async (req, res) => {
  try {
    const role = req.sessionUser?.role || "";
    if (!isManagerRole(role)) return res.status(403).json({ message: "Forbidden" });
    const diag = await getSyncDiagnostics({
      from: req.query.from,
      to: req.query.to,
    });
    res.json(diag);
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to fetch diagnostics" });
  }
});

router.post("/manager/sync-now", requireSession, async (req, res) => {
  try {
    const role = req.sessionUser?.role || "";
    if (!isManagerRole(role)) return res.status(403).json({ message: "Forbidden" });
    const hours = Math.max(1, Math.min(72, Number(req.body?.hours || 24)));
    const out = hasS2SConfig()
      ? await runIncrementalSync(hours)
      : await syncCallHistoryWindowViaConnectedUsers({
          from: new Date(Date.now() - hours * 60 * 60 * 1000),
          to: new Date(),
          pageSize: 100,
        });
    res.json({ ok: true, sync: out });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || "Sync failed" });
  }
});

router.get(
  "/manager/stream",
  (req, _res, next) => {
    if (!req.headers["x-session-user"] && req.query?.sessionUser) {
      req.headers["x-session-user"] = String(req.query.sessionUser);
    }
    next();
  },
  requireSession,
  async (req, res) => {
  const role = req.sessionUser?.role || "";
  if (!isManagerRole(role)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[calling-center] manager stream forbidden", {
        userId: String(getUserIdFromReq(req) || ""),
        normalizedRole: normalizeRole(role),
      });
    }
    return res.status(403).json({ message: "Forbidden" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  req.socket?.setKeepAlive?.(true);
  req.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  const range = getOverviewRangeFromQuery(req.query);
  addManagerOverviewClient(res, range);

  const ping = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch (_) {
      // handled on close
    }
  }, 15000);

  const initial = await buildManagerOverview(range);
  res.write(`event: ${MANAGER_OVERVIEW_EVENT}\n`);
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  req.on("close", () => {
    clearInterval(ping);
    removeManagerOverviewClient(res);
    try {
      res.end();
    } catch (_) {
      // noop
    }
  });
}
);

router.get("/:callId", requireSession, async (req, res) => {
  const row = await ZoomCallLog.findOne({ callId: req.params.callId }).lean();
  if (!row) return res.status(404).json({ message: "Not found" });

  const role = req.sessionUser?.role || "";
  const myId = String(getUserIdFromReq(req) || "");
  if (!isManagerRole(role) && String(row.agentId || "") !== myId) {
    return res.status(403).json({ message: "Forbidden" });
  }
  res.json(row);
});

router.put("/:callId/notes", requireSession, async (req, res) => {
  const notes = String(req.body?.notes || "");
  const row = await ZoomCallLog.findOneAndUpdate({ callId: req.params.callId }, { notes }, { new: true });
  if (!row) return res.status(404).json({ message: "Not found" });
  res.json({ ok: true, row });
});

router.get("/:callId/recording", requireSession, async (req, res) => {
  const row = await ZoomCallLog.findOne({ callId: req.params.callId }).lean();
  if (!row) return res.status(404).json({ message: "Not found" });
  res.json({ url: row.recordingUrl || "", status: row.recordingStatus || "none" });
});

router.get("/:callId/transcript", requireSession, async (req, res) => {
  const row = await ZoomCallLog.findOne({ callId: req.params.callId }).lean();
  if (!row) return res.status(404).json({ message: "Not found" });
  res.json({ transcript: row.transcriptContent || "", status: row.transcriptStatus || "none" });
});

module.exports = router;
