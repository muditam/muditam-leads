const express = require("express");
const router = express.Router();
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const crypto = require("crypto");
const Asset = require("../models/Add-Asset");

// ===== Wasabi S3 client =====
const {
  WASABI_ACCESS_KEY,
  WASABI_SECRET_KEY, 
  WASABI_REGION,  
  WASABI_BUCKET,
  WASABI_ENDPOINT,
} = process.env;

const s3 = new S3Client({
  region: WASABI_REGION, 
  endpoint: WASABI_ENDPOINT, 
  forcePathStyle: false,
  credentials: {
    accessKeyId: WASABI_ACCESS_KEY, 
    secretAccessKey: WASABI_SECRET_KEY,
  },
});

// Multer (memory)
const upload = multer({ storage: multer.memoryStorage() });

// ===== CRUD =====

// GET /api/assets
router.get("/", async (_req, res) => {
  try {
    const items = await Asset.find().sort({ updatedAt: -1 });
    res.json(items);
  } catch (err) {
    console.error("GET /assets error:", err);
    res.status(500).json({ message: "Failed to fetch assets" });
  }
});

// POST /api/assets
router.post("/", async (req, res) => {
  try {
    const { name, company, model, assetCode, imageUrls } = req.body;
    if (!name || !company || !model || !assetCode) {
      return res
        .status(400)
        .json({ message: "name, company, model and assetCode are required" });
    }

    const existing = await Asset.findOne({ assetCode: assetCode.trim() });
    if (existing) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }

    const doc = await Asset.create({
      name: name.trim(),
      company: company.trim(),
      model: model.trim(),
      assetCode: assetCode.trim(),
      imageUrls: Array.isArray(imageUrls)
        ? imageUrls.map((u) => String(u).trim()).filter(Boolean)
        : [],
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error("POST /assets error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }
    res.status(500).json({ message: "Failed to create asset" });
  }
});

// PUT /api/assets/:id
router.put("/:id", async (req, res) => {
  try {
    const { name, company, model, assetCode, imageUrls } = req.body;
    if (!name || !company || !model || !assetCode) {
      return res
        .status(400)
        .json({ message: "name, company, model and assetCode are required" });
    }

    const existsWithCode = await Asset.findOne({
      assetCode: assetCode.trim(),
      _id: { $ne: req.params.id },
    });
    if (existsWithCode) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }

    const updated = await Asset.findByIdAndUpdate(
      req.params.id,
      {
        name: name.trim(),
        company: company.trim(),
        model: model.trim(),
        assetCode: assetCode.trim(),
        imageUrls: Array.isArray(imageUrls)
          ? imageUrls.map((u) => String(u).trim()).filter(Boolean)
          : [],
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: "Asset not found" });
    res.json(updated);
  } catch (err) {
    console.error("PUT /assets/:id error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }
    res.status(500).json({ message: "Failed to update asset" });
  }
});

// DELETE /api/assets/:id
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Asset.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Asset not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /assets/:id error:", err);
    res.status(500).json({ message: "Failed to delete asset" });
  }
});

// POST /api/assets/upload  (multiple file upload)
router.post("/upload", upload.array("files", 15), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: "No files uploaded" });

    const prefix = (req.body.prefix || "asset").replace(/[^a-z0-9/_-]/gi, "_");
    const uploadedUrls = [];

    for (const file of files) {
      const ext = path.extname(file.originalname) || ".bin";
      const base = path.basename(file.originalname, ext).replace(/[^a-z0-9/_-]/gi, "_");
      const hash = crypto.randomBytes(8).toString("hex");
      const key = `${prefix}/${base}-${Date.now()}-${hash}${ext}`;

      const put = new PutObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        ACL: "public-read",
      });

      await s3.send(put);
      const url = `${WASABI_ENDPOINT}/${WASABI_BUCKET}/${encodeURIComponent(key)}`;
      uploadedUrls.push(url);
    }

    res.json({ ok: true, urls: uploadedUrls });
  } catch (err) {
    console.error("UPLOAD /assets/upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

module.exports = router;
