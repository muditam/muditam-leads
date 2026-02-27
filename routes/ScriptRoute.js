const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const multer   = require("multer");
const AWS      = require("aws-sdk");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");
const Script   = require("../models/scriptSchema");




const s3 = new AWS.S3({
  accessKeyId:     process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region:          process.env.WASABI_REGION,
  endpoint:        process.env.WASABI_ENDPOINT, // e.g. https://s3.ap-southeast-1.wasabisys.com
  s3ForcePathStyle: true,
});


// Multer: memory storage only — no temp files on disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB per file
});






const requireSession = (req, res, next) => {
  // 1️⃣  Header wins — frontend always sends the current logged-in user
  try {
    const headerUser = req.headers["x-session-user"];
    if (headerUser) {
      const parsed = JSON.parse(headerUser);
      // Accept as long as we have a fullName (email is optional)
      if (parsed?.fullName) {
        req.sessionUser = parsed;   // request-scoped only, never touches req.session
        return next();
      }
    }
  } catch (_) {}


  // 2️⃣  Fallback: server-side session (for requests that don't send the header)
  if (req.session?.user?.fullName) {
    req.sessionUser = req.session.user;
    return next();
  }


  return res.status(401).json({ message: "Unauthorized" });
};


// Role is stored as "Manager" in DB — toLowerCase() handles any casing
const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];
const isManager = (role = "") => MANAGER_ROLES.includes(role.toLowerCase());


// ── Full access = manager role  OR  hasTeam:true employee ──
const hasFullAccess = (user = {}) =>
  isManager(user.role) || user.hasTeam === true;




// ─────────────────────────────────────────────────────────────
// PRESIGN ROUTE — browser uploads directly to Wasabi
// Heroku is only asked for a signed URL (takes <1s, no timeout risk)
// ─────────────────────────────────────────────────────────────
// GET /api/scripts/presign?filename=myvideo.mp4&contentType=video/mp4
router.get("/presign", requireSession, async (req, res) => {
  try {
    const { filename, contentType } = req.query;
    if (!filename || !contentType)
      return res.status(400).json({ message: "filename and contentType required" });


    const ext = path.extname(filename) || "";
    const key = `scripts/${uuidv4()}${ext}`;


    // Heroku only generates this URL — it never touches the file bytes
    const presignedUrl = s3.getSignedUrl("putObject", {
      Bucket:      process.env.WASABI_BUCKET,
      Key:         key,
      ContentType: contentType,
      ACL:         "public-read",
      Expires:     3600, // URL valid for 1 hour — enough for any file size
    });


    const endpoint = (process.env.WASABI_ENDPOINT || "").replace(/\/$/, "");
    const finalUrl = `${endpoint}/${process.env.WASABI_BUCKET}/${key}`;


    res.json({ presignedUrl, finalUrl, key });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).json({ message: "Could not generate upload URL", error: err.message });
  }
});




router.post(
  "/upload/wasabi",
  requireSession,
  upload.array("files", 10),
  async (req, res) => {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ message: "No files uploaded" });


    try {
      const results = await Promise.all(
        req.files.map(async (file) => {
          const ext = path.extname(file.originalname) || "";
          const key = `scripts/${uuidv4()}${ext}`;


          await s3
            .putObject({
              Bucket:      process.env.WASABI_BUCKET,
              Key:         key,
              Body:        file.buffer,
              ContentType: file.mimetype,
              ACL:         "public-read",
            })
            .promise();


          // Build public URL from endpoint + bucket + key
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
  }
);


// ─────────────────────────────────────────────────────────────
// SCRIPT ROUTES
// ─────────────────────────────────────────────────────────────


/** GET /api/scripts  — list with optional filters */
router.get("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { stage, scriptType, scriptStatus } = req.query;


    let baseFilter = {};
    if (!hasFullAccess(user)) {
      if (!user.fullName) return res.json({ scripts: [], user: {} });
      baseFilter = { $or: [{ createdBy: user.fullName }, { editAssignedTo: user.fullName }] };
    }


    const extras = {};
    if (stage)        extras.stage        = stage;
    if (scriptType)   extras.scriptType   = scriptType;
    if (scriptStatus) extras.scriptStatus = scriptStatus;


    let query = baseFilter;
    if (Object.keys(extras).length > 0) {
      query = Object.keys(baseFilter).length > 0
        ? { $and: [baseFilter, extras] }
        : extras;
    }


    const scripts = await Script.find(query).sort({ createdAt: -1 });
    res.json({
      scripts,
      user: { fullName: user.fullName, email: user.email, role: user.role, hasTeam: user.hasTeam },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** GET /api/scripts/stages-summary — per-stage counts */
router.get("/stages-summary", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    if (!hasFullAccess(user) && !user.fullName)
      return res.json({});
    const base = hasFullAccess(user) ? {} : { createdBy: user.fullName };
    const agg  = await Script.aggregate([
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


/** GET /api/scripts/designers */
router.get("/designers", requireSession, async (req, res) => {
  try {
    const Employee = mongoose.model("Employee");
    const list = await Employee.find({
      role:   { $regex: /design/i },
      status: "active",
    }).select("fullName email");
    res.json(list);
  } catch {
    res.json([]);
  }
});


/** GET /api/scripts/:id */
router.get("/:id", requireSession, async (req, res) => {
  try {
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    res.json(script);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** POST /api/scripts — create */
router.post("/", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { scriptType, scriptText, referenceLink } = req.body;
    if (!scriptType || !scriptText)
      return res
        .status(400)
        .json({ message: "scriptType and scriptText required" });


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


/** PUT /api/scripts/:id — update editable fields */
router.put("/:id", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    if (!hasFullAccess(user) && script.createdBy !== user.fullName)
      return res.status(403).json({ message: "Forbidden" });


    const allowed = [
      "scriptType", "scriptText", "referenceLink",
      "scriptStatus", "approverComment", "holdReason",
      "cutComment", "editAssignedTo", "editComment", "postComment",
    ];
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) script[f] = req.body[f];
    });
    await script.save();
    res.json({ message: "Updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** DELETE /api/scripts/:id */
router.delete("/:id", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
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






/** POST /api/scripts/:id/proceed-to-shoot */
router.post("/:id/proceed-to-shoot", requireSession, async (req, res) => {
  try {
    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });
    if (script.scriptStatus !== "Approved")
      return res
        .status(400)
        .json({ message: "Script must be Approved first" });
    script.stage            = "Shoot Pending";
    script.proceedToShootAt = new Date();
    await script.save();
    res.json({ message: "Moved to Shoot Pending", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** POST /api/scripts/:id/shoot-done */
router.post("/:id/shoot-done", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
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


/**
 * POST /api/scripts/:id/save-cut-file
 * Saves the uploaded file URL to the script WITHOUT changing the stage.
 * Stage stays "Shoot Done" — user must click "Yes, Cut Done" separately.
 */
router.post("/:id/save-cut-file", requireSession, async (req, res) => {
  try {
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;
    if (!cutVideoUrl) return res.status(400).json({ message: "cutVideoUrl required" });


    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });


    script.cutVideoUrl  = cutVideoUrl;
    script.cutVideoName = cutVideoName || cutVideoUrl.split("/").pop();
    if (cutComment !== undefined) script.cutComment = cutComment;
    // Stage NOT changed here — stays as-is (Shoot Done)
    await script.save();
    res.json({ message: "Cut file saved", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** POST /api/scripts/:id/cut-upload */
router.post("/:id/cut-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const { cutVideoUrl, cutVideoName, cutComment } = req.body;
    if (!cutVideoUrl)
      return res.status(400).json({ message: "cutVideoUrl required" });


    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });


    script.cutVideoUrl  = cutVideoUrl;
    script.cutVideoName = cutVideoName || cutVideoUrl.split("/").pop();
    script.cutComment   = cutComment || "";
    script.stage        = "Cut Done";
    script.cutDoneAt    = new Date();
    script.cutDoneBy    = user.fullName;
    await script.save();
    res.json({ message: "Cut uploaded", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/** POST /api/scripts/:id/edit-assign */
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


/** POST /api/scripts/:id/edit-upload */
router.post("/:id/edit-upload", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const {
      editFileUrl, editFileName,
      editComment, editStatus, editHoldReason,
    } = req.body;


    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });


    if (editFileUrl) {
      script.editFileUrl  = editFileUrl;
      script.editFileName = editFileName || editFileUrl.split("/").pop();
      script.stage        = "Edit Done";
      script.editDoneAt   = new Date();
      script.editDoneBy   = user.fullName;
    }
    if (editComment    !== undefined) script.editComment    = editComment;
    if (editHoldReason !== undefined) script.editHoldReason = editHoldReason;
    if (editStatus) {
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




router.post("/:id/post-update", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const {
      postStatus,
      postHoldReason,
      postPublishStatus,
      postFileUrl,
      postFileName,
      postComment,
    } = req.body;


    const script = await Script.findById(req.params.id);
    if (!script) return res.status(404).json({ message: "Not found" });


    const now = new Date();


    // ── postStatus ──────────────────────────────────────────
    if (postStatus !== undefined && postStatus !== script.postStatus) {
      script.postStatus          = postStatus;
      script.postStatusUpdatedAt = now;
      script.postStatusUpdatedBy = user.fullName;
    }


    // ── hold / rejection reason ─────────────────────────────
    if (postHoldReason !== undefined) script.postHoldReason = postHoldReason;


    // ── postPublishStatus ───────────────────────────────────
    if (
      postPublishStatus !== undefined &&
      postPublishStatus !== script.postPublishStatus
    ) {
      script.postPublishStatus          = postPublishStatus;
      script.postPublishStatusUpdatedAt = now;


      // postedAt + postedBy only on the first non-empty publish status
      if (postPublishStatus && !script.postedAt) {
        script.postedAt = now;
        script.postedBy = user.fullName;
        if (script.stage !== "Post") script.stage = "Post";
      }
    }


    // ── file ────────────────────────────────────────────────
    if (postFileUrl) {
      script.postFileUrl  = postFileUrl;
      script.postFileName = postFileName || postFileUrl.split("/").pop();
      if (script.stage !== "Post") {
        script.stage    = "Post";
        script.postedAt = script.postedAt || now;
        script.postedBy = script.postedBy || user.fullName;
      }
    }


    // ── comment ─────────────────────────────────────────────
    if (postComment !== undefined) script.postComment = postComment;


    await script.save();
    res.json({ message: "Post updated", script });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Keep the old /post route for backwards compat — delegates to /post-update
router.post("/:id/post", requireSession, async (req, res) => {
  try {
    const user = req.sessionUser;
    const {
      postStatus, postHoldReason,
      postFileUrl, postFileName, postComment,
    } = req.body;


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

