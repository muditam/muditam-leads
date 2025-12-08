const express = require("express");
const router = express.Router();
const PurchaseRecord = require("../models/PurchaseRecord");
const Vendor = require("../models/Vendor");
const multer = require("multer");
const AWS = require("aws-sdk");
const XLSX = require("xlsx");

// ----------------------
// MULTER
// ----------------------
const upload = multer({ storage: multer.memoryStorage() });

// ----------------------
// WASABI CONFIG
// ----------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region: process.env.WASABI_REGION,
  s3ForcePathStyle: true,
});

// ----------------------
// GET ALL RECORDS
// ----------------------
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// ----------------------
// CREATE A RECORD (INLINE ADD)  ✔ Option A
// ----------------------
router.post("/", async (req, res) => {
  try {
    const record = await PurchaseRecord.create(req.body);
    res.json(record);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// ----------------------
// UPDATE A RECORD (INLINE PATCH)
// ----------------------
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update purchase record" });
  }
});

// ----------------------
// SOFT DELETE RECORD
// ----------------------
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to delete record" });
  }
});

// ----------------------
// UPLOAD INVOICE → WASABI
// ----------------------
router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: `purchase-invoices/${Date.now()}_${file.originalname}`,
      Body: file.buffer,
      ACL: "public-read",
      ContentType: file.mimetype,
    };

    const uploadRes = await s3.upload(params).promise();

    res.json({ url: uploadRes.Location });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Invoice upload failed" });
  }
});

// ----------------------
// BULK UPLOAD (CSV / EXCEL)
// ----------------------
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const defaultDate = req.body.date;

    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const created = [];

    for (const r of rows) {
      const record = await PurchaseRecord.create({
        date: r["Date"] || defaultDate,
        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",
        vendorName: r["Vendor Name"] || "",
        amount: r["Amount"] || 0,
        matched2B: false,
        tally: false,
      });

      created.push(record);
    }

    res.json(created);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Bulk upload failed" });
  }
});

module.exports = router;
