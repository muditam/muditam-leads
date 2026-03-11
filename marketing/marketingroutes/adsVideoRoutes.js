const express = require("express");
const router = express.Router();

router.use(express.json({ limit: "10mb" }));
router.use(express.urlencoded({ limit: "10mb", extended: true }));

const mongoose = require("mongoose");
const multer = require("multer");
const AWS = require("aws-sdk");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const AdsVideo = require("../marketingschema/adsVideoSchema");

// ─────────────────────────────────────────────────────────────
// S3 / Wasabi
// ─────────────────────────────────────────────────────────────
const s3 = new AWS.S3({
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region: process.env.WASABI_REGION,
  endpoint: process.env.WASABI_ENDPOINT,
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
const isManager = (role = "") =>
  MANAGER_ROLES.includes(String(role || "").toLowerCase());
const hasFullAccess = (user = {}) => isManager(user.role) || user.hasTeam === true;

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────
function buildDateFilter(query) {
  const { dateField, dateFrom, dateTo } = query;
  if (!dateField || (!dateFrom && !dateTo)) return {};

  const range = {};

  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d)) {
      range.$gte = new Date(d.toISOString().split("T")[0] + "T00:00:00.000Z");
    }
  }

  if (dateTo) {
    const d = new Date(dateTo);
    if (!isNaN(d)) {
      range.$lte = new Date(d.toISOString().split("T")[0] + "T23:59:59.999Z");
    }
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
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ciExactRegex(value) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

async function moveAfterApproval(item) {
  if (item.ideationStatus !== "Approved") {
    throw new Error("Ideation must be Approved first");
  }

  if (item.stage !== "Ideation") {
    throw new Error("Item has already moved beyond Ideation");
  }

  item.proceedAfterApprovalAt = new Date();

  if (item.hasShoot) {
    item.stage = "Shoot Pending";
  } else {
    item.stage = "Edit Pending";
  }

  await item.save();
  return item;
}

// ─────────────────────────────────────────────────────────────
// Presign upload URL
// ─────────────────────────────────────────────────────────────
router.get("/presign", requireSession, async (req, res) => {
  try {
    const { filename, contentType } = req.query;

    if (!filename || !contentType) {
      return res.status(400).json({ message: "filename and contentType required" });
    }

    const ext = path.extname(filename) || "";
    const key = `ads-videos/${uuidv4()}${ext}`;

    const presignedUrl = s3.getSignedUrl("putObject", {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      ContentType: contentType,
      Expires: 3600,
    });

    const endpoint = (process.env.WASABI_ENDPOINT || "").replace(/\/$/, "");
    const finalUrl = `${endpoint}/${process.env.WASABI_BUCKET}/${key}`;

    res.json({ presignedUrl, finalUrl, key });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).json({
      message: "Could not generate upload URL",
      error: err.message,
    });
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
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Expires: 60 * 5,
    });

    res.json({ url });
  } catch (err) {
    console.error("Presign download error:", err);
    res.status(500).json({ message: "Could not generate download URL" });
  }
});

// ─────────────────────────────────────────────────────────────
// Legacy upload route
// ─────────────────────────────────────────────────────────────
router.post("/upload/wasabi", requireSession, upload.array("files", 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: "No files uploaded" });
  }

  try {
    const results = await Promise.all(
      req.files.map(async (file) => {
        const ext = path.extname(file.originalname) || "";
        const key = `ads-videos/${uuidv4()}${ext}`;

        await s3
          .putObject({
            Bucket: process.env.WASABI_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
          .promise();

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
// GET /creators
// ─────────────────────────────────────────────────────────────
router.get("/creators", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    let baseFilter = {};
    if (!hasFullAccess(user)) {
      if (!user.fullName) return res.json({ creators: [] });
      baseFilter = {
        $or: [{ createdBy: user.fullName }, { editAssignedTo: user.fullName }],
      };
    }

    const extras = {};
    if (req.query.stage) {
      const stages = toStrArray(req.query.stage);
      extras.stage = stages.length > 1 ? { $in: stages } : stages[0];
    }

    const match = Object.keys(extras).length
      ? { $and: [baseFilter, extras] }
      : baseFilter;

    const agg = await AdsVideo.aggregate([
      { $match: match },
      { $group: { _id: "$createdBy", count: { $sum: 1 } } },
      { $project: { _id: 0, fullName: "$_id", count: 1 } },
      { $sort: { fullName: 1 } },
    ]);

    res.json({ creators: agg.filter((x) => x.fullName) });
  } catch {
    res.json({ creators: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /stages-summary
// ─────────────────────────────────────────────────────────────
router.get("/stages-summary", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user) && !user.fullName) return res.json({});

    const base = hasFullAccess(user)
      ? {}
      : { $or: [{ createdBy: user.fullName }, { editAssignedTo: user.fullName }] };

    const agg = await AdsVideo.aggregate([
      { $match: base },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]);

    const summary = {};
    agg.forEach((r) => {
      summary[r._id] = r.count;
    });

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
    const list = await Employee.find({
      role: { $regex: /design|edit|marketing/i },
      status: "active",
    }).select("fullName email");

    res.json(list);
  } catch {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET / — main list
// ─────────────────────────────────────────────────────────────
router.get("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    const {
      stage,
      adType,
      ideationStatus,
      hasShoot,
      creator,
      assignedTo,
      editAssignedTo,
      adsVideoId,
    } = req.query;

    const qRaw = (req.query.q ?? req.query.search ?? "").toString().trim();

    const page = clampInt(req.query.page, 1, 1, 1000000);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const skip = (page - 1) * limit;

    const ALLOWED_SORT_FIELDS = [
      "createdAt",
      "updatedAt",
      "approvedAt",
      "proceedAfterApprovalAt",
      "shootDoneAt",
      "cutDoneAt",
      "editDoneAt",
      "postedAt",
    ];

    const sortBy = ALLOWED_SORT_FIELDS.includes(req.query.sortBy)
      ? req.query.sortBy
      : "createdAt";
    const sortDir =
      String(req.query.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;

    const sort = { [sortBy]: sortDir, _id: sortDir };

    let baseFilter = {};
    if (!hasFullAccess(user)) {
      if (!user.fullName) {
        return res.json({
          adsVideos: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
          user: {},
        });
      }

      baseFilter = {
        $or: [{ createdBy: user.fullName }, { editAssignedTo: user.fullName }],
      };
    }

    const extras = {};

    if (stage) {
      const stages = toStrArray(stage);
      extras.stage = stages.length > 1 ? { $in: stages } : stages[0];
    }

    if (adType) {
      const types = toStrArray(adType);
      extras.adType = types.length > 1 ? { $in: types } : types[0];
    }

    if (ideationStatus) {
      const statuses = toStrArray(ideationStatus);
      extras.ideationStatus = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    if (creator) {
      const creators = toStrArray(creator);
      extras.createdBy =
        creators.length > 1 ? { $in: creators } : ciExactRegex(creators[0]);
    }

    const assignee = assignedTo ?? editAssignedTo;
    if (assignee) {
      const assignees = toStrArray(assignee);
      extras.editAssignedTo =
        assignees.length > 1 ? { $in: assignees } : ciExactRegex(assignees[0]);
    }

    if (adsVideoId) {
      const q = String(adsVideoId).trim();
      if (q) extras.adsVideoId = new RegExp(escapeRegex(q), "i");
    }

    if (hasShoot !== undefined && hasShoot !== "") {
      if (String(hasShoot).toLowerCase() === "true" || String(hasShoot) === "1") {
        extras.hasShoot = true;
      }
      if (String(hasShoot).toLowerCase() === "false" || String(hasShoot) === "0") {
        extras.hasShoot = false;
      }
    }

    if (qRaw) {
      const re = new RegExp(escapeRegex(qRaw), "i");
      extras.$or = [
        { adsVideoId: re },
        { title: re },
        { ideaText: re },
        { referenceLink: re },
        { createdBy: re },
        { editAssignedTo: re },
        { adType: re },
      ];
    }

    const dateFilter = buildDateFilter(req.query);

    const conditions = [
      ...(Object.keys(baseFilter).length ? [baseFilter] : []),
      ...(Object.keys(extras).length ? [extras] : []),
      ...(Object.keys(dateFilter).length ? [dateFilter] : []),
    ];

    const query =
      conditions.length === 0
        ? {}
        : conditions.length === 1
        ? conditions[0]
        : { $and: conditions };

    const [total, adsVideos] = await Promise.all([
      AdsVideo.countDocuments(query),
      AdsVideo.find(query).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    const totalPages = Math.ceil(total / limit) || 0;

    return res.json({
      adsVideos,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        sortBy,
        sortDir: sortDir === 1 ? "asc" : "desc",
      },
      user: {
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        hasTeam: user.hasTeam,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────
router.get("/:id", requireSession, async (req, res) => {
  try {
    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST / — create ideation
// ─────────────────────────────────────────────────────────────
router.post("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { adType, title, ideaText, referenceLink, hasShoot } = req.body;

    if (!adType || !title || !ideaText) {
      return res.status(400).json({
        message: "adType, title and ideaText are required",
      });
    }

    const item = new AdsVideo({
      adType,
      title,
      ideaText,
      referenceLink: referenceLink || "",
      hasShoot: hasShoot === undefined ? true : !!hasShoot,
      createdBy: user.fullName,
      createdByEmail: user.email,
    });

    await item.save();
    res.status(201).json({ message: "Created", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id — general update
// ─────────────────────────────────────────────────────────────
router.put("/:id", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const item = await AdsVideo.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Not found" });
    if (!hasFullAccess(user) && item.createdBy !== user.fullName) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (req.body.hasShoot !== undefined && item.stage !== "Ideation") {
      return res.status(400).json({
        message: "hasShoot can only be changed while item is in Ideation stage",
      });
    }

    const allowed = [
      "adType",
      "title",
      "ideaText",
      "referenceLink",
      "hasShoot",
      "ideationStatus",
      "approverComment",
      "holdReason",
      "cutComment",
      "editAssignedTo",
      "editComment",
      "postComment",
    ];

    allowed.forEach((f) => {
      if (req.body[f] !== undefined) item[f] = req.body[f];
    });

    if (req.body.ideationStatus === "Approved") {
      if (!item.approvedBy) {
        item.approvedBy = user.fullName;
        item.approvedAt = new Date();
      }
    }

    if (req.body.ideationStatus && req.body.ideationStatus !== "Approved") {
      item.approvedBy = "";
      item.approvedAt = undefined;
    }

    await item.save();
    res.json({ message: "Updated", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────
router.delete("/:id", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const item = await AdsVideo.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Not found" });
    if (!hasFullAccess(user) && item.createdBy !== user.fullName) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await AdsVideo.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/proceed-after-approval
// Approved + hasShoot=true  -> Shoot Pending
// Approved + hasShoot=false -> Edit Pending
// ─────────────────────────────────────────────────────────────
router.post("/:id/proceed-after-approval", requireSession, async (req, res) => {
  try {
    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    try {
      await moveAfterApproval(item);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    return res.json({
      message: item.hasShoot
        ? "Moved to Shoot Pending"
        : "Moved directly to Edit Pending",
      adsVideo: item,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// optional alias for compatibility
router.post("/:id/proceed-to-shoot", requireSession, async (req, res) => {
  try {
    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    try {
      await moveAfterApproval(item);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    return res.json({
      message: item.hasShoot
        ? "Moved to Shoot Pending"
        : "Moved directly to Edit Pending",
      adsVideo: item,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/shoot-done
// ─────────────────────────────────────────────────────────────
router.post("/:id/shoot-done", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const item = await AdsVideo.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Not found" });
    if (!item.hasShoot) {
      return res.status(400).json({ message: "This item does not require a shoot" });
    }

    item.stage = "Shoot Done";
    item.shootDoneAt = new Date();
    item.shootDoneBy = user.fullName;

    await item.save();
    res.json({ message: "Shoot done", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/save-cut-file
// save cut file without marking done
// ─────────────────────────────────────────────────────────────
router.post("/:id/save-cut-file", requireSession, async (req, res) => {
  try {
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;
    if (!cutVideoUrl) {
      return res.status(400).json({ message: "cutVideoUrl required" });
    }

    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    if (!item.hasShoot) {
      return res.status(400).json({ message: "This item does not require a cut stage" });
    }

    item.cutVideoUrl = cutVideoUrl;
    item.cutVideoName = cutVideoName || cutVideoUrl.split("/").pop();
    if (cutComment !== undefined) item.cutComment = cutComment;

    await item.save();
    res.json({ message: "Cut file saved", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/cut-upload
// upload cut file and mark Cut Done
// ─────────────────────────────────────────────────────────────
router.post("/:id/cut-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;

    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    if (!item.hasShoot) {
      return res.status(400).json({ message: "This item does not require a cut stage" });
    }

    if (cutVideoUrl && cutVideoUrl !== "pending") {
      item.cutVideoUrl = cutVideoUrl;
      item.cutVideoName = cutVideoName || cutVideoUrl.split("/").pop();
      item.cutUploadedBy = user.fullName;
    }

    if (cutComment !== undefined) item.cutComment = cutComment;

    item.stage = "Cut Done";
    item.cutDoneAt = new Date();
    item.cutDoneBy = user.fullName;

    await item.save();
    res.json({ message: "Cut uploaded", adsVideo: item });
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
    const item = await AdsVideo.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Not found" });

    item.editAssignedTo = editAssignedTo || "";

    if (item.stage === "Cut Done") {
      item.stage = "Edit Pending";
    }

    await item.save();
    res.json({ message: "Assigned", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/edit-upload
// can upload final edited video OR only update comment/status
// ─────────────────────────────────────────────────────────────
router.post("/:id/edit-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const {
      editVideoUrl,
      editVideoName,
      editComment,
      editStatus,
      editHoldReason,
    } = req.body;

    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (editStatus === "Reshoot" && !item.hasShoot) {
      return res.status(400).json({
        message: "Reshoot is not valid when hasShoot is false",
      });
    }

    if (editVideoUrl) {
      item.editVideoUrl = editVideoUrl;
      item.editVideoName = editVideoName || editVideoUrl.split("/").pop();
      item.editDoneAt = new Date();
      item.editDoneBy = user.fullName;

      if (item.stage !== "Post") {
        item.stage = "Edit Done";
      }
    }

    if (editComment !== undefined) item.editComment = editComment;
    if (editHoldReason !== undefined) item.editHoldReason = editHoldReason;

    if (editStatus !== undefined) {
      item.editStatus = editStatus;

      if (editStatus === "Reshoot") {
        item.stage = "Shoot Pending";
      }

      if (editStatus === "Re-edit") {
        item.stage = item.hasShoot ? "Cut Done" : "Edit Pending";
      }

      if (editStatus === "On Hold") {
        item.stage = "Edit Pending";
      }
    }

    await item.save();
    res.json({ message: "Edit updated", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/post-update
// ─────────────────────────────────────────────────────────────
router.post("/:id/post-update", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const {
      postStatus,
      postHoldReason,
      postPublishStatus,
      postVideoUrl,
      postVideoName,
      postComment,
    } = req.body;

    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    const now = new Date();

    if (postStatus !== undefined && postStatus !== item.postStatus) {
      item.postStatus = postStatus;
      item.postStatusUpdatedAt = now;
      item.postStatusUpdatedBy = user.fullName;
    }

    if (postHoldReason !== undefined) item.postHoldReason = postHoldReason;

    if (
      postPublishStatus !== undefined &&
      postPublishStatus !== item.postPublishStatus
    ) {
      item.postPublishStatus = postPublishStatus;
      item.postPublishStatusUpdatedAt = now;

      if (postPublishStatus && !item.postedAt) {
        item.postedAt = now;
        item.postedBy = user.fullName;
        if (item.stage !== "Post") item.stage = "Post";
      }
    }

    if (postVideoUrl) {
      item.postVideoUrl = postVideoUrl;
      item.postVideoName = postVideoName || postVideoUrl.split("/").pop();

      if (item.stage !== "Post") {
        item.stage = "Post";
        item.postedAt = item.postedAt || now;
        item.postedBy = item.postedBy || user.fullName;
      }
    }

    if (postComment !== undefined) item.postComment = postComment;

    await item.save();
    res.json({ message: "Post updated", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/post (legacy)
// ─────────────────────────────────────────────────────────────
router.post("/:id/post", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { postStatus, postHoldReason, postVideoUrl, postVideoName, postComment } =
      req.body;

    const item = await AdsVideo.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    const now = new Date();

    if (postStatus && postStatus !== item.postStatus) {
      item.postStatus = postStatus;
      item.postStatusUpdatedAt = now;
      item.postStatusUpdatedBy = user.fullName;
    }

    if (postHoldReason !== undefined) item.postHoldReason = postHoldReason;
    if (postComment !== undefined) item.postComment = postComment;

    if (postVideoUrl) {
      item.postVideoUrl = postVideoUrl;
      item.postVideoName = postVideoName || postVideoUrl.split("/").pop();
      item.stage = "Post";
      item.postedAt = item.postedAt || now;
      item.postedBy = item.postedBy || user.fullName;
    }

    await item.save();
    res.json({ message: "Post updated", adsVideo: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;