// routes/PurchaseRcrds.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const AWS = require("aws-sdk");

const PurchaseRecord = require("../models/PurchaseRcrd");

// ----------------------
// MULTER SETUP
// ----------------------
const upload = multer({ storage: multer.memoryStorage() });

// ----------------------
// WASABI S3 CONFIG
// ----------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});


// -----------------------------------------------------
// GET ALL PURCHASE RECORDS
// -----------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 });

    return res.json(records);
  } catch (err) {
    console.error("GET /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});


// -----------------------------------------------------
// CREATE A SINGLE PURCHASE RECORD
// -----------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const created = await PurchaseRecord.create(req.body);
    return res.json(created);
  } catch (err) {
    console.error("POST /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to create purchase record" });
  }
});


// -----------------------------------------------------
// UPDATE RECORD
// -----------------------------------------------------
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Record not found" });
    }

    return res.json(updated);
  } catch (err) {
    console.error("PATCH /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to update purchase record" });
  }
});


// -----------------------------------------------------
// SOFT DELETE RECORD
// -----------------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );

    if (!deleted) {
      return res.status(404).json({ error: "Record not found" });
    }

    return res.json(deleted);
  } catch (err) {
    console.error("DELETE /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to delete purchase record" });
  }
});


// -----------------------------------------------------
// UPLOAD INVOICE → WASABI
// -----------------------------------------------------
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

    const uploaded = await s3.upload(params).promise();

    return res.json({ url: uploaded.Location });
  } catch (err) {
    console.error("Invoice Upload Error:", err);
    return res.status(500).json({ error: "Failed to upload invoice" });
  }
});


// -----------------------------------------------------
// BULK UPLOAD (CSV / EXCEL)
// -----------------------------------------------------
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded" });

    const fileBuffer = req.file.buffer;

    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const defaultDate = req.body.date || new Date();

    let createdList = [];

    for (const r of rows) {
      const entry = await PurchaseRecord.create({
        date: r["Date"] || defaultDate,
        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",
        vendorName: r["Vendor Name"] || "",
        amount: Number(r["Amount"] || 0),
        matched2B: false,
        tally: false,
        isDeleted: false,
      });

      createdList.push(entry);
    }

    return res.json({
      success: true,
      count: createdList.length,
      records: createdList,
    });
  } catch (err) {
    console.error("Bulk Upload Error:", err);
    return res.status(500).json({ error: "Bulk upload failed" });
  }
});


// -----------------------------------------------------
module.exports = router;
