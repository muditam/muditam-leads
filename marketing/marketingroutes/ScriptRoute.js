const express  = require("express");
const router   = express.Router();
router.use(express.json({ limit: "10mb" }));
router.use(express.urlencoded({ limit: "10mb", extended: true }));
const mongoose = require("mongoose");
const multer   = require("multer");
const AWS      = require("aws-sdk");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");
const Script   = require("../marketingschema/scriptSchema");

// ─────────────────────────────────────────────────────────────
// S3 / Wasabi
// ─────────────────────────────────────────────────────────────
const s3 = new AWS.S3({
  accessKeyId:      process.env.WASABI_ACCESS_KEY,
  secretAccessKey:  process.env.WASABI_SECRET_KEY,
  region:           process.env.WASABI_REGION,
  endpoint:         process.env.WASABI_ENDPOINT,
  s3ForcePathStyle: true,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────
const requireSession = (req, res, next) => {
  try {
    const headerUser = req.headers["x-session-user"];
    if (headerUser) {
      const parsed = JSON.parse(headerUser);
      if (parsed?.fullName) {
        req.sessionUser = parsed;
        return next();
      }
    }
  } catch (_) {}
  if (req.session?.user?.fullName) {
    req.sessionUser = req.session.user;
    return next();
  }
  return res.status(401).json({ message: "Unauthorized" });
};

const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];
const isManager     = (role = "") => MANAGER_ROLES.includes(String(role || "").toLowerCase());
const hasFullAccess = (user = {}) => isManager(user.role) || user.hasTeam === true;

// ─────────────────────────────────────────────────────────────
// Stages visible to ALL logged-in users (full production queue)
// ─────────────────────────────────────────────────────────────
const PUBLIC_STAGES = new Set([
  "Shoot Pending",
  "Shoot Done",
  "Cut Pending",
  "Cut Done",
  "Edit Pending",
  "Edit Done",
  "Post",
]);

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────
function buildDateFilter(query) {
  const { dateField, dateFrom, dateTo } = query;
  if (!dateField || (!dateFrom && !dateTo)) return {};
  const range = {};
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d)) range.$gte = new Date(d.toISOString().split("T")[0] + "T00:00:00.000Z");
  }
  if (dateTo) {
    const d = new Date(dateTo);
    if (!isNaN(d)) range.$lte = new Date(d.toISOString().split("T")[0] + "T23:59:59.999Z");
  }
  if (!Object.keys(range).length) return {};
  return { [dateField]: range };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function escapeRegex(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toStrArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function ciExactRegex(value) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

// ─────────────────────────────────────────────────────────────
// Presign upload URL
// ─────────────────────────────────────────────────────────────
router.get("/presign", requireSession, async (req, res) => {
  try {
    const { filename, contentType } = req.query;
    if (!filename || !contentType)
      return res.status(400).json({ message: "filename and contentType required" });

    const ext = path.extname(filename) || "";
    const key = `scripts/${uuidv4()}${ext}`;

    const presignedUrl = s3.getSignedUrl("putObject", {
      Bucket:      process.env.WASABI_BUCKET,
      Key:         key,
      ContentType: contentType,
      Expires:     3600,
    });

    const endpoint = (process.env.WASABI_ENDPOINT || "").replace(/\/$/, "");
    const finalUrl  = `${endpoint}/${process.env.WASABI_BUCKET}/${key}`;

    res.json({ presignedUrl, finalUrl, key });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).json({ message: "Could not generate upload URL", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Presign download URL
// ─────────────────────────────────────────────────────────────
router.get("/presign-download", requireSession, async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ message: "Key required" });

    const url = s3.getSignedUrl("getObject", {
      Bucket:  process.env.WASABI_BUCKET,
      Key:     key,
      Expires: 60 * 5,
    });

    res.json({ url });
  } catch (err) {
    console.error("Presign download error:", err);
    res.status(500).json({ message: "Could not generate download URL" });
  }
});

// ─────────────────────────────────────────────────────────────
// Legacy upload route (kept for compatibility)
// ─────────────────────────────────────────────────────────────
router.post("/upload/wasabi", requireSession, upload.array("files", 10), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ message: "No files uploaded" });

  try {
    const results = await Promise.all(
      req.files.map(async (file) => {
        const ext = path.extname(file.originalname) || "";
        const key = `scripts/${uuidv4()}${ext}`;

        await s3.putObject({
          Bucket:      process.env.WASABI_BUCKET,
          Key:         key,
          Body:        file.buffer,
          ContentType: file.mimetype,
        }).promise();

        const endpoint = (process.env.WASABI_ENDPOINT || "").replace(/\/$/, "");
        const url = `${endpoint}/${process.env.WASABI_BUCKET}/${key}`;
        return { originalName: file.originalname, url, key };
      })
    );
    res.json({ urls: results });
  } catch (err) {
    console.error("Wasabi upload error:", err);
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /creators — distinct creator list (respects access)
// ─────────────────────────────────────────────────────────────
router.get("/creators", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    let baseFilter = {};
    if (!hasFullAccess(user)) {
      if (!user.fullName) return res.json({ creators: [] });
      baseFilter = { $or: [{ createdBy: user.fullName }, { editAssignedTo: user.fullName }] };
    }

    const extras = {};
    if (req.query.stage) {
      const stages = toStrArray(req.query.stage);
      extras.stage = stages.length > 1 ? { $in: stages } : stages[0];
    }

    const match = Object.keys(extras).length
      ? { $and: [baseFilter, extras] }
      : baseFilter;

    const agg = await Script.aggregate([
      { $match: match },
      { $group: { _id: "$createdBy", count: { $sum: 1 } } },
      { $project: { _id: 0, fullName: "$_id", count: 1 } },
      { $sort: { fullName: 1 } },
    ]);

    res.json({ creators: agg.filter((x) => x.fullName) });
  } catch (e) {
    res.json({ creators: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// GET / — main list with pagination, search, filters
// ✅ PUBLIC_STAGES: non-managers see full production queue
// ✅ Script Library: non-managers only see their own scripts
// ─────────────────────────────────────────────────────────────
router.get("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    const { stage, scriptType, scriptStatus } = req.query;

    const assignedTo  = req.query.assignedTo  ?? req.query.editAssignedTo;
    const creator     = req.query.creator     ?? req.query.createdBy;
    const scriptIdQ   = req.query.scriptId;
    const scriptIdExact =
      String(req.query.scriptIdExact || "").toLowerCase() === "true" ||
      String(req.query.scriptIdExact || "") === "1";

    const qRaw = (req.query.q ?? req.query.search ?? req.query.scriptSearch ?? "").toString().trim();

    const page  = clampInt(req.query.page, 1, 1, 1000000);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const skip  = (page - 1) * limit;

    const ALLOWED_SORT_FIELDS = [
      "createdAt", "updatedAt", "proceedToShootAt",
      "cutDoneAt", "editDoneAt", "shootDoneAt", "postedAt",
    ];
    const sortBy  = ALLOWED_SORT_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
    const sortDir = String(req.query.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;
    const sort    = { [sortBy]: sortDir, _id: sortDir };

    // ── Access filter ──────────────────────────────────────────
    let baseFilter = {};

    if (!hasFullAccess(user)) {
      if (!user.fullName) {
        return res.json({
          scripts: [],
          pagination: { page, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
          user: {},
        });
      } 
      baseFilter = {};
    }

    // ── Extra filters ──────────────────────────────────────────
    const extras = {};

    if (stage) {
      const stages = toStrArray(stage);
      extras.stage = stages.length > 1 ? { $in: stages } : stages[0];
    }

    if (scriptType) {
      const types = toStrArray(scriptType);
      extras.scriptType = types.length > 1 ? { $in: types } : types[0];
    }

    if (scriptStatus) {
      const statuses = toStrArray(scriptStatus);
      extras.scriptStatus = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    if (creator) {
      const creators = toStrArray(creator);
      extras.createdBy = creators.length > 1 ? { $in: creators } : ciExactRegex(creators[0]);
    }

    if (assignedTo) {
      const assignees = toStrArray(assignedTo);
      extras.editAssignedTo = assignees.length > 1 ? { $in: assignees } : ciExactRegex(assignees[0]);
    }

    if (scriptIdQ) {
      const q = String(scriptIdQ).trim();
      if (q) extras.scriptId = scriptIdExact ? ciExactRegex(q) : new RegExp(escapeRegex(q), "i");
    }

    if (qRaw) {
      const re = new RegExp(escapeRegex(qRaw), "i");
      extras.$or = [
        { scriptId:       re },
        { scriptText:     re },
        { referenceLink:  re },
        { createdBy:      re },
        { editAssignedTo: re },
        { scriptType:     re },
      ];
    }

    const dateFilter = buildDateFilter(req.query);

    const conditions = [
      ...(Object.keys(baseFilter).length  ? [baseFilter]  : []),
      ...(Object.keys(extras).length      ? [extras]      : []),
      ...(Object.keys(dateFilter).length  ? [dateFilter]  : []),
    ];

    const query =
      conditions.length === 0 ? {} :
      conditions.length === 1 ? conditions[0] :
      { $and: conditions };

    const [total, scripts] = await Promise.all([
      Script.countDocuments(query),
      Script.find(query).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    const totalPages = Math.ceil(total / limit) || 0;

    return res.json({
      scripts,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext:  page < totalPages,
        hasPrev:  page > 1,
        sortBy,
        sortDir: sortDir === 1 ? "asc" : "desc",
      },
      user: {
        fullName: user.fullName,
        email:    user.email,
        role:     user.role,
        hasTeam:  user.hasTeam,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /stages-summary
// ─────────────────────────────────────────────────────────────
router.get("/stages-summary", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user) && !user.fullName) return res.json({});
    const base = hasFullAccess(user) ? {} : { createdBy: user.fullName };

    const agg = await Script.aggregate([
      { $match: base },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]);

    const summary = {};
    agg.forEach((r) => (summary[r._id] = r.count));
    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /designers
// ─────────────────────────────────────────────────────────────
router.get("/designers", requireSession, async (req, res) => {
  try {
    const Employee = mongoose.model("Employee");
    const list = await Employee.find({ role: { $regex: /design/i }, status: "active" }).select("fullName email");
    res.json(list);
  } catch {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────
router.get("/:id", requireSession, async (req, res) => {
  try {
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    res.json(script);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST / — create script
// ─────────────────────────────────────────────────────────────
router.post("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { scriptType, scriptText, referenceLink } = req.body;
    if (!scriptType || !scriptText)
      return res.status(400).json({ message: "scriptType and scriptText required" });

    const script = new Script({
      scriptType,
      scriptText,
      referenceLink:  referenceLink || "",
      createdBy:      user.fullName,
      createdByEmail: user.email,
    });
    await script.save();
    res.status(201).json({ message: "Created", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id — general update
// ✅ Captures approvedBy + approvedAt when status → Approved
// ✅ Clears approvedBy when status reverts away from Approved
// ─────────────────────────────────────────────────────────────
router.put("/:id", requireSession, async (req, res) => {
  try {
    const user   = req.sessionUser;
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    if (!hasFullAccess(user) && script.createdBy !== user.fullName)
      return res.status(403).json({ message: "Forbidden" });

    const allowed = [
      "scriptType", "scriptText", "referenceLink",
      "scriptStatus", "approverComment", "holdReason",
      "cutComment", "editAssignedTo", "editComment", "postComment",
    ];
    allowed.forEach((f) => { if (req.body[f] !== undefined) script[f] = req.body[f]; });

    // Capture approver info when status → Approved (set only once)
    if (req.body.scriptStatus === "Approved") {
      if (!script.approvedBy) {
        script.approvedBy = user.fullName;
        script.approvedAt = new Date();
      }
    }

    // Clear approver info if status reverts away from Approved
    if (req.body.scriptStatus && req.body.scriptStatus !== "Approved") {
      script.approvedBy = "";
      script.approvedAt = undefined;
    }

    await script.save();
    res.json({ message: "Updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────
router.delete("/:id", requireSession, async (req, res) => {
  try {
    const user   = req.sessionUser;
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    if (!hasFullAccess(user) && script.createdBy !== user.fullName)
      return res.status(403).json({ message: "Forbidden" });
    await Script.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/proceed-to-shoot
// ─────────────────────────────────────────────────────────────
router.post("/:id/proceed-to-shoot", requireSession, async (req, res) => {
  try {
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    if (script.scriptStatus !== "Approved")
      return res.status(400).json({ message: "Script must be Approved first" });
    script.stage            = "Shoot Pending";
    script.proceedToShootAt = new Date();
    await script.save();
    res.json({ message: "Moved to Shoot Pending", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/shoot-done
// ─────────────────────────────────────────────────────────────
router.post("/:id/shoot-done", requireSession, async (req, res) => {
  try {
    const user   = req.sessionUser;
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    script.stage       = "Shoot Done";
    script.shootDoneAt = new Date();
    script.shootDoneBy = user.fullName;
    await script.save();
    res.json({ message: "Shoot done", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/save-cut-file — save cut file URL without marking done
// ─────────────────────────────────────────────────────────────
router.post("/:id/save-cut-file", requireSession, async (req, res) => {
  try {
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;
    if (!cutVideoUrl) return res.status(400).json({ message: "cutVideoUrl required" });

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    script.cutVideoUrl  = cutVideoUrl;
    script.cutVideoName = cutVideoName || cutVideoUrl.split("/").pop();
    if (cutComment !== undefined) script.cutComment = cutComment;

    await script.save();
    res.json({ message: "Cut file saved", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/cut-upload — upload cut file AND mark Cut Done
// ✅ cutUploadedBy tracked separately from cutDoneBy
// ─────────────────────────────────────────────────────────────
router.post("/:id/cut-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;
    if (!cutVideoUrl) return res.status(400).json({ message: "cutVideoUrl required" });

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    script.cutVideoUrl   = cutVideoUrl;
    script.cutVideoName  = cutVideoName || cutVideoUrl.split("/").pop();
    script.cutComment    = cutComment || "";
    script.stage         = "Cut Done";
    script.cutDoneAt     = new Date();
    script.cutDoneBy     = user.fullName;
    script.cutUploadedBy = user.fullName; // ✅ track uploader separately

    await script.save();
    res.json({ message: "Cut uploaded", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/edit-assign
// ─────────────────────────────────────────────────────────────
router.post("/:id/edit-assign", requireSession, async (req, res) => {
  try {
    const { editAssignedTo } = req.body;
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    script.editAssignedTo = editAssignedTo || "";
    if (script.stage === "Cut Done") script.stage = "Edit Pending";
    await script.save();
    res.json({ message: "Assigned", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
 
router.post("/:id/edit-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { editFileUrl, editFileName, editComment, editStatus, editHoldReason } = req.body;

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    if (editFileUrl) {
      script.editFileUrl  = editFileUrl;
      script.editFileName = editFileName || editFileUrl.split("/").pop();
      script.editDoneAt   = new Date();
      script.editDoneBy   = user.fullName;
      // ✅ keep Post stage if already posted
      if (script.stage !== "Post") {
        script.stage = "Edit Done";
      }
    }

    if (editComment    !== undefined) script.editComment    = editComment;
    if (editHoldReason !== undefined) script.editHoldReason = editHoldReason;

    if (editStatus !== undefined) {
      script.editStatus = editStatus;
      if (editStatus === "Reshoot") script.stage = "Shoot Pending";
      if (editStatus === "Re-edit") script.stage = "Cut Done";
    }

    await script.save();
    res.json({ message: "Edit updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
 
router.post("/:id/edit-thumbnail", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { editThumbUrl, editThumbName } = req.body;

    if (!editThumbUrl) return res.status(400).json({ message: "editThumbUrl required" });

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    script.editThumbUrl       = editThumbUrl;
    script.editThumbName      = editThumbName || editThumbUrl.split("/").pop();
    script.editThumbUpdatedAt = new Date();
    script.editThumbUpdatedBy = user.fullName || "";

    await script.save();
    res.json({ message: "Thumbnail updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
 
router.post("/:id/post-update", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { postStatus, postHoldReason, postPublishStatus, postFileUrl, postFileName, postComment } = req.body;

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    const now = new Date();

    if (postStatus !== undefined && postStatus !== script.postStatus) {
      script.postStatus          = postStatus;
      script.postStatusUpdatedAt = now;
      script.postStatusUpdatedBy = user.fullName;
    }
    if (postHoldReason !== undefined) script.postHoldReason = postHoldReason;

    if (postPublishStatus !== undefined && postPublishStatus !== script.postPublishStatus) {
      script.postPublishStatus          = postPublishStatus;
      script.postPublishStatusUpdatedAt = now;
      if (postPublishStatus && !script.postedAt) {
        script.postedAt = now;
        script.postedBy = user.fullName;
        if (script.stage !== "Post") script.stage = "Post";
      }
    }

    if (postFileUrl) {
      script.postFileUrl  = postFileUrl;
      script.postFileName = postFileName || postFileUrl.split("/").pop();
      if (script.stage !== "Post") {
        script.stage    = "Post";
        script.postedAt = script.postedAt || now;
        script.postedBy = script.postedBy || user.fullName;
      }
    }

    if (postComment !== undefined) script.postComment = postComment;

    await script.save();
    res.json({ message: "Post updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/post (legacy / simpler post route)
// ─────────────────────────────────────────────────────────────
router.post("/:id/post", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { postStatus, postHoldReason, postFileUrl, postFileName, postComment } = req.body;

    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });

    const now = new Date();

    if (postStatus && postStatus !== script.postStatus) {
      script.postStatus          = postStatus;
      script.postStatusUpdatedAt = now;
      script.postStatusUpdatedBy = user.fullName;
    }
    if (postHoldReason !== undefined) script.postHoldReason = postHoldReason;
    if (postComment    !== undefined) script.postComment    = postComment;

    if (postFileUrl) {
      script.postFileUrl  = postFileUrl;
      script.postFileName = postFileName || postFileUrl.split("/").pop();
      script.stage        = "Post";
      script.postedAt     = script.postedAt || now;
      script.postedBy     = script.postedBy || user.fullName;
    }

    await script.save();
    res.json({ message: "Post updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

