// routes/marketingDashboard.js
const express  = require("express");
const router   = express.Router();
const Script   = require("../marketing/marketingschema/scriptSchema");


const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];
const isManager     = (role = "") => MANAGER_ROLES.includes(String(role || "").toLowerCase());
const hasFullAccess = (user = {}) => isManager(user.role) || user.hasTeam === true;


const requireSession = (req, res, next) => {
  try {
    const headerUser = req.headers["x-session-user"];
    if (headerUser) {
      const parsed = JSON.parse(headerUser);
      if (parsed?.fullName) { req.sessionUser = parsed; return next(); }
    }
  } catch (_) {}
  if (req.session?.user?.fullName) { req.sessionUser = req.session.user; return next(); }
  return res.status(401).json({ message: "Unauthorized" });
};


function buildDateRange(dateFrom, dateTo) {
  const range = {};
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d)) range.$gte = new Date(d.toISOString().split("T")[0] + "T00:00:00.000Z");
  }
  if (dateTo) {
    const d = new Date(dateTo);
    if (!isNaN(d)) range.$lte = new Date(d.toISOString().split("T")[0] + "T23:59:59.999Z");
  }
  return Object.keys(range).length ? range : null;
}


// ── Reusable buildRange from named preset ────────────────────
function buildRangeFromPreset(dateRange, customStart, customEnd) {
  const now = new Date();
  if (!dateRange || dateRange === "all") return null;
  if (dateRange === "today") {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    return { $gte: s, $lte: e };
  }
  if (dateRange === "yesterday") {
    const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setDate(e.getDate() - 1); e.setHours(23, 59, 59, 999);
    return { $gte: s, $lte: e };
  }
  if (dateRange === "last7") {
    const s = new Date(now); s.setDate(s.getDate() - 6); s.setHours(0, 0, 0, 0);
    return { $gte: s, $lte: now };
  }
  if (dateRange === "last30") {
    const s = new Date(now); s.setDate(s.getDate() - 29); s.setHours(0, 0, 0, 0);
    return { $gte: s, $lte: now };
  }
  if (dateRange === "lastMonth") {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { $gte: s, $lte: e };
  }
  if (dateRange === "custom" && customStart && customEnd) {
    const s = new Date(customStart + "T00:00:00.000Z");
    const e = new Date(customEnd   + "T23:59:59.999Z");
    if (!isNaN(s) && !isNaN(e)) return { $gte: s, $lte: e };
  }
  return null;
}


// ────────────────────────────────────────────────────────────
// GET /summary
// Returns: stage counts, published, pending-no-action,
//          blocked, writer metrics, editor metrics, recent activity
// ────────────────────────────────────────────────────────────
router.get("/summary", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { dateFrom, dateTo } = req.query;
    const dateRange = buildDateRange(dateFrom, dateTo);
    const dateFilter = dateRange ? { createdAt: dateRange } : {};


    // ── 1. Total Scripts ──────────────────────────────────────
    const totalScripts = await Script.countDocuments(dateFilter);


    // ── 2. Stage-wise counts ──────────────────────────────────
    const stageAgg = await Script.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]);
    const stageCounts = {};
    stageAgg.forEach((r) => { stageCounts[r._id] = r.count; });


    // ── 3. Published Scripts ──────────────────────────────────
    const [postedCount, usedInAdsCount] = await Promise.all([
      Script.countDocuments({ postPublishStatus: "Posted",      ...(dateRange ? { postedAt: dateRange } : {}) }),
      Script.countDocuments({ postPublishStatus: "Used in Ads", ...(dateRange ? { postedAt: dateRange } : {}) }),
    ]);


    // ── 4. Pending Without Action (stuck > 3 days) ────────────
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const pendingWithoutAction = await Script.countDocuments({
      stage: { $in: ["Shoot Pending", "Cut Done", "Edit Pending"] },
      updatedAt: { $lt: threeDaysAgo },
    });


    // ── 5. Blocked Scripts ────────────────────────────────────
    const blockedFilter = {
      $or: [
        { editStatus: { $in: ["Re-edit", "Reshoot"] } },
        { postStatus: { $in: ["Re-edit", "Reshoot", "On Hold"] } },
        { editStatus: "On Hold" },
      ],
      ...dateFilter,
    };
    const blockedScripts = await Script.countDocuments(blockedFilter);


    const [reEditCount, reshootCount, onHoldCount] = await Promise.all([
      Script.countDocuments({ editStatus: "Re-edit",  ...dateFilter }),
      Script.countDocuments({ $or: [{ editStatus: "Reshoot" }, { postStatus: "Reshoot" }], ...dateFilter }),
      Script.countDocuments({ $or: [{ editStatus: "On Hold" }, { postStatus: "On Hold"  }], ...dateFilter }),
    ]);


    // ── 6. Writer Metrics (per script writer) ─────────────────
    const writerAgg = await Script.aggregate([
      { $match: { createdBy: { $exists: true, $ne: "" }, ...dateFilter } },
      {
        $group: {
          _id:           "$createdBy",
          totalWritten:  { $sum: 1 },
          // approvedAt is now set in schema when status → Approved
          approved:      { $sum: { $cond: [{ $eq: ["$scriptStatus", "Approved"] }, 1, 0] } },
          pendingReview: { $sum: { $cond: [{ $eq: ["$stage", "Script"] }, 1, 0] } },
          rewrite:       { $sum: { $cond: [{ $eq: ["$scriptStatus", "Rewrite"] }, 1, 0] } },
          onHold:        { $sum: { $cond: [{ $eq: ["$scriptStatus", "On Hold"] }, 1, 0] } },
          rejected:      { $sum: { $cond: [{ $eq: ["$scriptStatus", "Rejected"] }, 1, 0] } },
          shootDone:     { $sum: { $cond: [{ $in: ["$stage", ["Shoot Done","Cut Pending","Cut Done","Edit Pending","Edit Done","Post"]] }, 1, 0] } },
          posted:        { $sum: { $cond: [{ $eq: ["$stage", "Post"] }, 1, 0] } },
        },
      },
      { $sort: { totalWritten: -1 } },
    ]);


    const writerMetrics = writerAgg.map((w) => ({
      name:          w._id,
      totalWritten:  w.totalWritten,
      approved:      w.approved,
      pendingReview: w.pendingReview,
      rewrite:       w.rewrite,
      onHold:        w.onHold,
      rejected:      w.rejected,
      shootDone:     w.shootDone,
      posted:        w.posted,
    }));


    // ── 7. Editor Metrics (per editor) ───────────────────────
    const editorAgg = await Script.aggregate([
      { $match: { editAssignedTo: { $exists: true, $ne: "" }, ...dateFilter } },
      {
        $group: {
          _id: "$editAssignedTo",
          assigned:  { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$stage", "Edit Done"] }, 1, 0] } },
          pending:   { $sum: { $cond: [{ $in: ["$stage", ["Edit Pending", "Cut Done"]] }, 1, 0] } },
          reEdit:    { $sum: { $cond: [{ $eq: ["$editStatus", "Re-edit"] }, 1, 0] } },
          reshoot:   { $sum: { $cond: [{ $eq: ["$editStatus", "Reshoot"] }, 1, 0] } },
          onHold:    { $sum: { $cond: [{ $eq: ["$editStatus", "On Hold"] }, 1, 0] } },
        },
      },
      { $sort: { assigned: -1 } },
    ]);


    // avg turnaround per editor (editDoneAt - cutDoneAt in hours)
    const turnaroundAgg = await Script.aggregate([
      {
        $match: {
          editAssignedTo: { $exists: true, $ne: "" },
          editDoneAt: { $exists: true },
          cutDoneAt:  { $exists: true },
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: "$editAssignedTo",
          avgHours: {
            $avg: {
              $divide: [{ $subtract: ["$editDoneAt", "$cutDoneAt"] }, 1000 * 60 * 60],
            },
          },
        },
      },
    ]);
    const turnaroundMap = {};
    turnaroundAgg.forEach((r) => { turnaroundMap[r._id] = Math.round(r.avgHours || 0); });


    const editorMetrics = editorAgg.map((e) => ({
      name:            e._id,
      assigned:        e.assigned,
      completed:       e.completed,
      pending:         e.pending,
      blocked:         e.reEdit + e.reshoot + e.onHold,
      reEdit:          e.reEdit,
      reshoot:         e.reshoot,
      onHold:          e.onHold,
      avgTurnaround:   turnaroundMap[e._id] || null,
    }));


    // ── 8. Recent Activity ────────────────────────────────────
    const recentScripts = await Script.find(dateFilter)
      .sort({ updatedAt: -1 })
      .limit(15)
      .select("scriptId scriptType stage updatedAt shootDoneBy cutDoneBy editDoneBy postedBy editAssignedTo createdBy");


    const recentActivity = recentScripts.map((s) => {
      let action = `Stage: ${s.stage}`;
      let actor  = s.createdBy;
      if (s.stage === "Shoot Done")    { action = "Shoot completed";   actor = s.shootDoneBy    || actor; }
      else if (s.stage === "Cut Done")      { action = "Cut completed";     actor = s.cutDoneBy      || actor; }
      else if (s.stage === "Edit Done")     { action = "Edit completed";    actor = s.editDoneBy     || actor; }
      else if (s.stage === "Post")          { action = "Posted";            actor = s.postedBy       || actor; }
      else if (s.stage === "Edit Pending")  { action = "Assigned to edit";  actor = s.editAssignedTo || actor; }
      return { scriptId: s.scriptId, scriptType: s.scriptType, action, actor, stage: s.stage, time: s.updatedAt };
    });


    res.json({
      totalScripts,
      stageCounts,
      published: {
        posted:    postedCount,
        usedInAds: usedInAdsCount,
        total:     postedCount + usedInAdsCount,
      },
      pendingWithoutAction,
      blocked: {
        total:   blockedScripts,
        reEdit:  reEditCount,
        reshoot: reshootCount,
        onHold:  onHoldCount,
      },
      writerMetrics,
      editorMetrics,
      recentActivity,
    });
  } catch (err) {
    console.error("Dashboard summary error:", err);
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /report  — leaderboards + publish breakdown
// ────────────────────────────────────────────────────────────
router.get("/report", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { dateRange, customStart, customEnd } = req.query;
    const range = buildRangeFromPreset(dateRange, customStart, customEnd);
    const dateFilter = (field) => range ? { [field]: range } : {};


    const [totalScripts, totalShoots, totalCuts, totalEdits, totalPosts] = await Promise.all([
      Script.countDocuments({ ...dateFilter("createdAt") }),
      Script.countDocuments({ shootDoneAt: { $exists: true }, ...dateFilter("shootDoneAt") }),
      Script.countDocuments({ cutDoneAt:   { $exists: true }, ...dateFilter("cutDoneAt") }),
      Script.countDocuments({ editDoneAt:  { $exists: true }, ...dateFilter("editDoneAt") }),
      Script.countDocuments({ postedAt:    { $exists: true }, ...dateFilter("postedAt") }),
    ]);


    const leaderboard = (matchExtra, groupField) =>
      Script.aggregate([
        { $match: { [groupField]: { $exists: true, $ne: "" }, ...matchExtra } },
        { $group: { _id: `$${groupField}`, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]);


    const [scripts, shoots, cuts, uploads, edits, posts] = await Promise.all([
      leaderboard(dateFilter("createdAt"),   "createdBy"),
      leaderboard(dateFilter("shootDoneAt"), "shootDoneBy"),
      leaderboard(dateFilter("cutDoneAt"),   "cutDoneBy"),
      Script.aggregate([
        { $match: { cutVideoUrl: { $exists: true, $ne: "" }, cutUploadedBy: { $exists: true, $ne: "" }, ...dateFilter("cutDoneAt") } },
        { $group: { _id: "$cutUploadedBy", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      leaderboard(dateFilter("editDoneAt"), "editDoneBy"),
      leaderboard(dateFilter("postedAt"),   "postedBy"),
    ]);


    const publishAgg = await Script.aggregate([
      { $match: { stage: "Post", ...dateFilter("postedAt") } },
      { $group: { _id: { $ifNull: ["$postPublishStatus", "Not Published"] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);


    res.json({
      summary: { totalScripts, totalShoots, totalCuts, totalEdits, totalPosts },
      boards:  { scripts, shoots, cuts, uploads, edits, posts },
      publish: publishAgg,
    });
  } catch (err) {
    console.error("Report route error:", err);
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /scripts-by-stage
// ────────────────────────────────────────────────────────────
router.get("/scripts-by-stage", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { stage, dateFrom, dateTo } = req.query;
    if (!stage) return res.status(400).json({ message: "stage required" });


    const dateRange = buildDateRange(dateFrom, dateTo);
    const filter = {
      stage: stage.includes(",") ? { $in: stage.split(",") } : stage,
      ...(dateRange ? { createdAt: dateRange } : {}),
    };


    const scripts = await Script.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .select("scriptId scriptType scriptText stage createdBy createdAt updatedAt editAssignedTo editStatus postStatus cutDoneAt editDoneAt shootDoneAt");


    res.json({ scripts, total: scripts.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /scripts-by-employee  (editor drill-down)
// ────────────────────────────────────────────────────────────
router.get("/scripts-by-employee", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { employeeName, filter: empFilter, dateFrom, dateTo } = req.query;
    if (!employeeName) return res.status(400).json({ message: "employeeName required" });


    const dateRange = buildDateRange(dateFrom, dateTo);
    let match = {
      editAssignedTo: employeeName,
      ...(dateRange ? { createdAt: dateRange } : {}),
    };


    if (empFilter === "pending")   match.stage = { $in: ["Edit Pending", "Cut Done"] };
    if (empFilter === "completed") match.stage = "Edit Done";
    if (empFilter === "blocked")   match = { ...match, $or: [{ editStatus: { $in: ["Re-edit", "Reshoot", "On Hold"] } }] };


    const scripts = await Script.find(match)
      .sort({ updatedAt: -1 })
      .limit(200)
      .select("scriptId scriptType scriptText stage editStatus postStatus createdBy createdAt editDoneAt cutDoneAt");


    res.json({ scripts, total: scripts.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /blocked-scripts  — now supports optional employeeName filter
// ────────────────────────────────────────────────────────────
router.get("/blocked-scripts", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { dateFrom, dateTo, employeeName } = req.query;
    const dateRange = buildDateRange(dateFrom, dateTo);


    const filter = {
      $or: [
        { editStatus: { $in: ["Re-edit", "Reshoot", "On Hold"] } },
        { postStatus: { $in: ["Re-edit", "Reshoot", "On Hold", "Rejected"] } },
      ],
      ...(dateRange ? { createdAt: dateRange } : {}),
      // FIX: filter by employee if provided
      ...(employeeName ? { editAssignedTo: employeeName } : {}),
    };


    const scripts = await Script.find(filter)
      .sort({ updatedAt: -1 })
      .select("scriptId scriptType scriptText stage editStatus postStatus editAssignedTo createdBy updatedAt");


    res.json({ scripts, total: scripts.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /scripts-by-person  — leaderboard drill-down
// ────────────────────────────────────────────────────────────
router.get("/scripts-by-person", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { name, field, dateRange, customStart, customEnd, dateFrom, dateTo } = req.query;
    const cleanName = (name || "").trim();
    if (!cleanName || !field) return res.status(400).json({ message: "name and field are required" });


    // Support BOTH param formats:
    //   - dateRange/customStart/customEnd  (from leaderboard / report page)
    //   - dateFrom/dateTo                  (from summary-based metrics tables)
    const range = buildRangeFromPreset(dateRange, customStart, customEnd)
               || buildDateRange(dateFrom, dateTo);


    const dateFieldMap = {
      createdBy:     "createdAt",
      shootDoneBy:   "shootDoneAt",
      cutDoneBy:     "cutDoneAt",
      cutUploadedBy: "cutDoneAt",
      editDoneBy:    "editDoneAt",
      postedBy:      "postedAt",
    };


    const dateFieldKey = dateFieldMap[field] || "createdAt";
    const dateFilter   = range ? { [dateFieldKey]: range } : {};


    const scripts = await Script.find({ [field]: cleanName, ...dateFilter })
      .sort({ createdAt: -1 })
      .limit(200)
      .select("scriptId scriptType stage scriptStatus approvedBy approvedAt proceedToShootAt createdAt shootDoneAt cutDoneAt editDoneAt postedAt");


    // DEBUG: remove after confirming fix
    console.log(`[scripts-by-person] field=${field} name="${cleanName}" range=${JSON.stringify(range)} found=${scripts.length}`);


    res.json({ scripts, total: scripts.length });
  } catch (err) {
    console.error("scripts-by-person error:", err);
    res.status(500).json({ message: err.message });
  }
});


// ────────────────────────────────────────────────────────────
// GET /writer-scripts  — writer metrics drill-down
// ────────────────────────────────────────────────────────────
router.get("/writer-scripts", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user)) return res.status(403).json({ message: "Access denied" });


    const { writerName, filter: writerFilter, dateFrom, dateTo } = req.query;
    if (!writerName) return res.status(400).json({ message: "writerName required" });


    const dateRange = buildDateRange(dateFrom, dateTo);
    let match = {
      createdBy: writerName,
      ...(dateRange ? { createdAt: dateRange } : {}),
    };


    if (writerFilter === "pendingReview") match.stage = "Script";
    if (writerFilter === "approved")      match.scriptStatus = "Approved";
    if (writerFilter === "rewrite")       match.scriptStatus = "Rewrite";
    if (writerFilter === "onHold")        match.scriptStatus = "On Hold";
    if (writerFilter === "rejected")      match.scriptStatus = "Rejected";
    if (writerFilter === "posted")        match.stage = "Post";


    const scripts = await Script.find(match)
      .sort({ createdAt: -1 })
      .limit(200)
      .select("scriptId scriptType stage scriptStatus approvedBy approvedAt approverComment proceedToShootAt createdAt shootDoneAt editDoneAt postedAt postPublishStatus");


    res.json({ scripts, total: scripts.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;

