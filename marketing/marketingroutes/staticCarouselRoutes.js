const express = require("express");
const router = express.Router();

router.use(express.json({ limit: "20mb" }));
router.use(express.urlencoded({ limit: "20mb", extended: true }));

const multer = require("multer");
const AWS = require("aws-sdk");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const StaticCarousel = require("../marketingschema/staticCarouselSchema");

// ─────────────────────────────────────────────────────────────
// Wasabi / S3
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
  limits: { fileSize: 100 * 1024 * 1024 },
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
const hasFullAccess = (user = {}) =>
  isManager(user.role) || user.hasTeam === true;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
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

function parseBoolFlexible(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(s)) return true;
  if (["false", "0", "no"].includes(s)) return false;
  return undefined;
}

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

function normalizeContentItems(items = []) {
  const input = Array.isArray(items) ? items : items ? [items] : [];

  return input
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          itemNo: idx + 1,
          headline: "",
          subHeadline: "",
          caption: item.trim(),
          description: "",
          cta: "",
          notes: "",
        };
      }

      return {
        itemNo: Number(item?.itemNo) || idx + 1,
        headline: String(item?.headline || "").trim(),
        subHeadline: String(item?.subHeadline || "").trim(),
        caption: String(item?.caption || "").trim(),
        description: String(item?.description || "").trim(),
        cta: String(item?.cta || "").trim(),
        notes: String(item?.notes || "").trim(),
      };
    })
    .filter(
      (x) =>
        x.headline ||
        x.subHeadline ||
        x.caption ||
        x.description ||
        x.cta ||
        x.notes
    )
    .map((x, idx) => ({ ...x, itemNo: idx + 1 }));
}

function normalizeAssets(list = [], uploadedBy = "") {
  const input = Array.isArray(list) ? list : list ? [list] : [];

  return input
    .map((item) => {
      if (typeof item === "string") {
        const cleanUrl = item.trim();
        if (!cleanUrl) return null;
        return {
          url: cleanUrl,
          name: cleanUrl.split("/").pop()?.split("?")[0] || "",
          key: "",
          uploadedAt: new Date(),
          uploadedBy,
        };
      }

      const url = String(item?.url || "").trim();
      if (!url) return null;

      return {
        url,
        name:
          String(item?.name || "").trim() ||
          url.split("/").pop()?.split("?")[0] ||
          "",
        key: String(item?.key || "").trim(),
        uploadedAt: item?.uploadedAt ? new Date(item.uploadedAt) : new Date(),
        uploadedBy: String(item?.uploadedBy || uploadedBy || "").trim(),
      };
    })
    .filter(Boolean);
}

function isImageContentType(contentType = "") {
  return /^image\//i.test(String(contentType || ""));
}

function validateContentTypeItems(contentType, items) {
  if (!["Static", "Carousel"].includes(contentType)) {
    return "contentType must be Static or Carousel";
  }

  if (!items.length) {
    return "At least one content item is required";
  }

  if (contentType === "Static" && items.length !== 1) {
    return "Static must have exactly 1 content item";
  }

  if (contentType === "Carousel" && items.length < 2) {
    return "Carousel must have at least 2 content items";
  }

  return "";
}

// ─────────────────────────────────────────────────────────────
// Presign upload URL (images only)
// ─────────────────────────────────────────────────────────────
router.get("/presign", requireSession, async (req, res) => {
  try {
    const { filename, contentType } = req.query;

    if (!filename || !contentType) {
      return res.status(400).json({ message: "filename and contentType required" });
    }

    if (!isImageContentType(contentType)) {
      return res.status(400).json({ message: "Only image uploads are allowed" });
    }

    const ext = path.extname(filename) || "";
    const key = `static-carousel/${uuidv4()}${ext}`;

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
// Legacy upload route (images only)
// ─────────────────────────────────────────────────────────────
router.post(
  "/upload/wasabi",
  requireSession,
  upload.array("files", 50),
  async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    try {
      const invalid = req.files.find((f) => !isImageContentType(f.mimetype));
      if (invalid) {
        return res.status(400).json({
          message: `Only image uploads are allowed. Invalid file: ${invalid.originalname}`,
        });
      }

      const results = await Promise.all(
        req.files.map(async (file) => {
          const ext = path.extname(file.originalname) || "";
          const key = `static-carousel/${uuidv4()}${ext}`;

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

      res.json({ assets: results });
    } catch (err) {
      console.error("Wasabi upload error:", err);
      res.status(500).json({ message: "Upload failed", error: err.message });
    }
  }
);

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

    const agg = await StaticCarousel.aggregate([
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

    const agg = await StaticCarousel.aggregate([
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
// GET /
// ─────────────────────────────────────────────────────────────
router.get("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    const {
      stage,
      scriptType,
      ideationStatus,
      contentType,
      creator,
      assignedTo,
      hasShoot,
    } = req.query;

    const staticCarouselIdQ = req.query.staticCarouselId ?? req.query.scriptId;
    const qRaw = (req.query.q ?? req.query.search ?? "").toString().trim();

    const hasShootFilter = parseBoolFlexible(hasShoot);

    const page = clampInt(req.query.page, 1, 1, 1000000);
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const skip = (page - 1) * limit;

    const ALLOWED_SORT_FIELDS = [
      "createdAt",
      "updatedAt",
      "approvedAt",
      "proceedToShootAt",
      "proceedToEditAt",
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
          staticCarousels: [],
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

    if (scriptType) {
      const types = toStrArray(scriptType);
      extras.scriptType = types.length > 1 ? { $in: types } : types[0];
    }

    if (ideationStatus) {
      const statuses = toStrArray(ideationStatus);
      extras.ideationStatus = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    if (contentType) {
      const types = toStrArray(contentType);
      extras.contentType = types.length > 1 ? { $in: types } : types[0];
    }

    if (typeof hasShootFilter === "boolean") {
      extras.hasShoot = hasShootFilter;
    }

    if (creator) {
      const creators = toStrArray(creator);
      extras.createdBy =
        creators.length > 1 ? { $in: creators } : ciExactRegex(creators[0]);
    }

    if (assignedTo) {
      const assignees = toStrArray(assignedTo);
      extras.editAssignedTo =
        assignees.length > 1 ? { $in: assignees } : ciExactRegex(assignees[0]);
    }

    if (staticCarouselIdQ) {
      const q = String(staticCarouselIdQ).trim();
      if (q) extras.staticCarouselId = new RegExp(escapeRegex(q), "i");
    }

    if (qRaw) {
      const re = new RegExp(escapeRegex(qRaw), "i");
      extras.$or = [
        { staticCarouselId: re },
        { title: re },
        { referenceLink: re },
        { createdBy: re },
        { editAssignedTo: re },
        { scriptType: re },
        { contentType: re },
        { "contentItems.headline": re },
        { "contentItems.subHeadline": re },
        { "contentItems.caption": re },
        { "contentItems.description": re },
        { "contentItems.notes": re },
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

    const [total, staticCarousels] = await Promise.all([
      StaticCarousel.countDocuments(query),
      StaticCarousel.find(query).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    const totalPages = Math.ceil(total / limit) || 0;

    return res.json({
      staticCarousels,
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
    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;

    const {
      contentType,
      hasShoot,
      scriptType,
      title,
      contentItems,
      referenceLink,
    } = req.body;

    if (!contentType || !["Static", "Carousel"].includes(contentType)) {
      return res.status(400).json({ message: "contentType must be Static or Carousel" });
    }

    if (!scriptType) {
      return res.status(400).json({ message: "scriptType is required" });
    }

    const normalizedItems = normalizeContentItems(contentItems);
    const validationError = validateContentTypeItems(contentType, normalizedItems);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const item = new StaticCarousel({
      contentType,
      hasShoot: !!parseBoolFlexible(hasShoot),
      scriptType,
      title: String(title || "").trim(),
      contentItems: normalizedItems,
      referenceLink: String(referenceLink || "").trim(),
      createdBy: user.fullName,
      createdByEmail: user.email,
    });

    await item.save();

    res.status(201).json({ message: "Created", staticCarousel: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id
// Approved:
// hasShoot=true  => Shoot Pending
// hasShoot=false => Edit Pending
// ─────────────────────────────────────────────────────────────
router.put("/:id", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (!hasFullAccess(user) && item.createdBy !== user.fullName) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const prevStatus = item.ideationStatus;

    if (req.body.contentType !== undefined) {
      const ct = String(req.body.contentType || "").trim();
      if (!["Static", "Carousel"].includes(ct)) {
        return res.status(400).json({ message: "contentType must be Static or Carousel" });
      }
      item.contentType = ct;
    }

    if (req.body.hasShoot !== undefined) {
      const parsed = parseBoolFlexible(req.body.hasShoot);
      if (typeof parsed === "boolean") item.hasShoot = parsed;
    }

    if (req.body.scriptType !== undefined) item.scriptType = req.body.scriptType;
    if (req.body.title !== undefined) item.title = String(req.body.title || "").trim();

    if (req.body.referenceLink !== undefined) {
      item.referenceLink = String(req.body.referenceLink || "").trim();
    }

    if (req.body.contentItems !== undefined) {
      const normalizedItems = normalizeContentItems(req.body.contentItems);
      const validationError = validateContentTypeItems(item.contentType, normalizedItems);
      if (validationError) {
        return res.status(400).json({ message: validationError });
      }
      item.contentItems = normalizedItems;
    }

    if (req.body.ideationStatus !== undefined) item.ideationStatus = req.body.ideationStatus;
    if (req.body.approverComment !== undefined) item.approverComment = req.body.approverComment;
    if (req.body.holdReason !== undefined) item.holdReason = req.body.holdReason;

    if (req.body.ideationStatus === "Approved" && prevStatus !== "Approved") {
      item.approvedBy = user.fullName;
      item.approvedAt = new Date();

      if (item.stage === "Ideation") {
        if (item.hasShoot) {
          item.stage = "Shoot Pending";
          item.proceedToShootAt = new Date();
        } else {
          item.stage = "Edit Pending";
          item.proceedToEditAt = new Date();
        }
      }
    }

    if (
      req.body.ideationStatus &&
      req.body.ideationStatus !== "Approved" &&
      prevStatus === "Approved" &&
      ["Ideation", "Shoot Pending", "Edit Pending"].includes(item.stage) &&
      !item.shootDoneAt &&
      !item.cutDoneAt &&
      !item.editDoneAt &&
      !item.postedAt
    ) {
      item.stage = "Ideation";
      item.proceedToShootAt = undefined;
      item.proceedToEditAt = undefined;
      item.approvedBy = "";
      item.approvedAt = undefined;
    }

    await item.save();
    res.json({ message: "Updated", staticCarousel: item });
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
    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (!hasFullAccess(user) && item.createdBy !== user.fullName) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await StaticCarousel.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
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
    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (!item.hasShoot) {
      return res.status(400).json({
        message: "This item does not require Shoot/Cut flow",
      });
    }

    item.stage = "Shoot Done";
    item.shootDoneAt = new Date();
    item.shootDoneBy = user.fullName;

    await item.save();
    res.json({ message: "Shoot done", staticCarousel: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/save-cut-files
// ─────────────────────────────────────────────────────────────
router.post("/:id/save-cut-files", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { cutAssets, cutComment } = req.body;

    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (!item.hasShoot) {
      return res.status(400).json({
        message: "This item does not require Cut flow",
      });
    }

    const assets = normalizeAssets(cutAssets, user.fullName);
    if (!assets.length) {
      return res.status(400).json({ message: "cutAssets is required" });
    }

    item.cutAssets = assets;
    item.cutUploadedBy = user.fullName;
    if (cutComment !== undefined) item.cutComment = cutComment;

    if (item.stage === "Shoot Done") item.stage = "Cut Pending";

    await item.save();
    res.json({ message: "Cut assets saved", staticCarousel: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/cut-upload
// ─────────────────────────────────────────────────────────────
router.post("/:id/cut-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { cutAssets, cutComment } = req.body;

    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (!item.hasShoot) {
      return res.status(400).json({
        message: "This item does not require Cut flow",
      });
    }

    if (cutAssets !== undefined) {
      const assets = normalizeAssets(cutAssets, user.fullName);
      if (assets.length) {
        item.cutAssets = assets;
        item.cutUploadedBy = user.fullName;
      }
    }

    if (!item.cutAssets.length) {
      return res.status(400).json({ message: "Please upload cut images first" });
    }

    if (cutComment !== undefined) item.cutComment = cutComment;

    item.stage = "Cut Done";
    item.cutDoneAt = new Date();
    item.cutDoneBy = user.fullName;

    await item.save();
    res.json({ message: "Cut uploaded", staticCarousel: item });
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

    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    item.editAssignedTo = editAssignedTo || "";

    if (!item.hasShoot && item.stage === "Ideation" && item.ideationStatus === "Approved") {
      item.stage = "Edit Pending";
      item.proceedToEditAt = item.proceedToEditAt || new Date();
    }

    if (item.hasShoot && item.stage === "Cut Done") {
      item.stage = "Edit Pending";
    }

    await item.save();
    res.json({ message: "Assigned", staticCarousel: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /:id/edit-upload
// ─────────────────────────────────────────────────────────────
router.post("/:id/edit-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { editAssets, editComment, editStatus, editHoldReason } = req.body;

    const item = await StaticCarousel.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });

    if (editAssets !== undefined) {
      const assets = normalizeAssets(editAssets, user.fullName);
      if (!assets.length) {
        return res.status(400).json({ message: "editAssets is required" });
      }

      item.editAssets = assets;
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
        item.stage = item.hasShoot ? "Shoot Pending" : "Edit Pending";
      }

      if (editStatus === "Re-edit") {
        item.stage = item.hasShoot ? "Cut Done" : "Edit Pending";
      }

      if (editStatus === "On Hold") {
        item.stage = "Edit Pending";
      }

      if (editStatus === "Done" && item.editAssets.length) {
        item.stage = "Edit Done";
      }
    }

    await item.save();
    res.json({ message: "Edit updated", staticCarousel: item });
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
      postAssets,
      postComment,
    } = req.body;

    const item = await StaticCarousel.findById(req.params.id);
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

    if (postAssets !== undefined) {
      const assets = normalizeAssets(postAssets, user.fullName);
      if (assets.length) {
        item.postAssets = assets;

        if (item.stage !== "Post") {
          item.stage = "Post";
          item.postedAt = item.postedAt || now;
          item.postedBy = item.postedBy || user.fullName;
        }
      }
    }

    if (postComment !== undefined) item.postComment = postComment;

    await item.save();
    res.json({ message: "Post updated", staticCarousel: item });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;