const express = require("express");
const requireSession = require("../middleware/requireSession");
const ZoomCallLog = require("../models/ZoomCallLog");
const { getUserIdFromReq } = require("../services/zoomAuthService");

const router = express.Router();

function isManagerRole(role = "") {
  const r = String(role || "").toLowerCase();
  return ["manager", "admin", "super admin", "super-admin", "developer"].includes(r);
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
      { transcriptContent: { $regex: q, $options: "i" } },
      { notes: { $regex: q, $options: "i" } },
    ];
  }

  const [rows, total] = await Promise.all([
    ZoomCallLog.find(filter).sort({ startTime: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ZoomCallLog.countDocuments(filter),
  ]);

  res.json({ rows, total, page, limit });
});

router.get("/manager/overview", requireSession, async (req, res) => {
  const role = req.sessionUser?.role || "";
  if (!isManagerRole(role)) return res.status(403).json({ message: "Forbidden" });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await ZoomCallLog.find({ createdAt: { $gte: since } }).lean();

  const total = rows.length;
  const answered = rows.filter((r) => Number(r.duration || 0) > 0).length;
  const missed = total - answered;
  const avgDuration = total ? Math.round(rows.reduce((s, r) => s + Number(r.duration || 0), 0) / total) : 0;

  const perAgent = {};
  for (const r of rows) {
    const key = String(r.agentId || "unassigned");
    if (!perAgent[key]) perAgent[key] = { agentId: key, calls: 0, answered: 0, missed: 0, duration: 0 };
    perAgent[key].calls += 1;
    perAgent[key].duration += Number(r.duration || 0);
    if (Number(r.duration || 0) > 0) perAgent[key].answered += 1;
    else perAgent[key].missed += 1;
  }

  res.json({ total, answered, missed, avgDuration, perAgent: Object.values(perAgent) });
});

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
