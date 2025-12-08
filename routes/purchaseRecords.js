const express = require("express");
const router = express.Router();
const PurchaseRecord = require("../models/PurchaseRecord");
const multer = require("multer");
const AWS = require("aws-sdk");

const upload = multer({ storage: multer.memoryStorage() });

// WASABI CONFIG
let s3;
try {
  s3 = new AWS.S3({
    endpoint: process.env.WASABI_ENDPOINT,
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY,
    region: process.env.WASABI_REGION,
    s3ForcePathStyle: true,
  });
} catch (err) {
  console.error("Wasabi Init Error:", err);
}

// GET ALL
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// CREATE
router.post("/", async (req, res) => {
  try {
    const record = await PurchaseRecord.create(req.body);
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// UPDATE
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update purchase record" });
  }
});

// DELETE (soft)
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

// INVOICE UPLOAD ONLY (NO BULK)
router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded" });

    const file = req.file;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: `purchase-invoices/${Date.now()}_${file.originalname}`,
      Body: file.buffer,
      ACL: "public-read",
      ContentType: file.mimetype,
    };

    const result = await s3.upload(params).promise();
    res.json({ url: result.Location });
  } catch (err) {
    console.error("WASABI Upload Error:", err);
    res.status(500).json({ error: "Invoice upload failed" });
  }
});

module.exports = router;
