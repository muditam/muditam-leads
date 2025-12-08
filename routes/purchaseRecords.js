const express = require("express");
const router = express.Router();
const multer = require("multer");
const PurchaseRecord = require("../models/PurchaseRecord");

// ==============================
// MULTER – MEMORY STORAGE
// (local to this router only)
// ==============================
const upload = multer({ storage: multer.memoryStorage() });

// ------------------------------
// Helper: safe number parse
// ------------------------------
function toNumber(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.\-]/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

// ==============================
// GET ALL PURCHASE RECORDS
// ==============================
// Used by frontend table load
router.get("/", async (req, res) => {
  try {
    // reverse chronological: latest date & createdAt first
    const records = await PurchaseRecord.find().sort({
      date: -1,
      createdAt: -1,
    });
    res.json(records);
  } catch (err) {
    console.error("GET /purchase-records error:", err);
    res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// ==============================
// CREATE A RECORD (INLINE ADD)
// ==============================
// Called when you add a row from frontend (no dialog)
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      date: body.date || null, // e.g. "2025-12-08"
      category: body.category || "",
      invoiceType: body.invoiceType || "",
      billingGST: body.billingGST || "",
      invoiceNo: body.invoiceNo || "",
      vendorId: body.vendorId || body.vendorId === "" ? body.vendorId : undefined,
      vendorName: body.vendorName || "",
      amount: toNumber(body.amount) ?? 0,
      invoiceUrl: body.invoiceUrl || "",
      matched2B: !!body.matched2B,
      tally: !!body.tally,
      isDeleted: !!body.isDeleted,
    };

    const record = await PurchaseRecord.create(payload);
    res.json(record);
  } catch (err) {
    console.error("POST /purchase-records error:", err);
    res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// ==============================
// UPDATE RECORD (INLINE PATCH)
// ==============================
// Used for toggling Matched 2B / Tally and future inline edits
router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };

    // sanitize amount if it comes in
    if (updates.amount !== undefined) {
      updates.amount = toNumber(updates.amount) ?? 0;
    }

    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Purchase record not found" });
    }

    res.json(updated);
  } catch (err) {
    console.error("PATCH /purchase-records error:", err);
    res.status(500).json({ error: "Failed to update purchase record" });
  }
});

// ==============================
// SOFT DELETE RECORD
// ==============================
// Frontend uses this from delete icon in Actions column
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Purchase record not found" });
    }

    res.json(updated);
  } catch (err) {
    console.error("DELETE /purchase-records error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

// ==============================
// UPLOAD INVOICE → WASABI
// ==============================
// POST /api/purchase-records/upload-invoice
// FormData: file
router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file received" });
    }

    // Lazy-load AWS so heavy deps don't affect server startup
    const AWS = require("aws-sdk");

    const s3 = new AWS.S3({
      endpoint: process.env.WASABI_ENDPOINT,
      accessKeyId: process.env.WASABI_ACCESS_KEY,
      secretAccessKey: process.env.WASABI_SECRET_KEY,
      region: process.env.WASABI_REGION,
      s3ForcePathStyle: true,
    });

    const file = req.file;

    const key = `purchase-invoices/${Date.now()}_${file.originalname}`;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Body: file.buffer,
      ACL: "public-read",
      ContentType: file.mimetype,
    };

    const result = await s3.upload(params).promise();

    if (!result || !result.Location) {
      throw new Error("No Location returned from Wasabi upload");
    }

    res.json({ url: result.Location });
  } catch (err) {
    console.error("UPLOAD INVOICE ERROR:", err);
    res.status(500).json({ error: "Failed to upload invoice" });
  }
});

// ==============================
// BULK UPLOAD (CSV / EXCEL)
// ==============================
// POST /api/purchase-records/bulk-upload
// FormData: file, date (yyyy-mm-dd for Date column)
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // date from frontend to use when Excel has no Date column
    const defaultDate = req.body.date || null;

    // Lazy-load XLSX (heavy) to avoid impacting Heroku startup
    const XLSX = require("xlsx");

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const docs = [];

    for (const r of rows) {
      const amount = toNumber(r["Amount"]) ?? 0;

      docs.push({
        date: r["Date"] || defaultDate,
        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",
        vendorName: r["Vendor Name"] || "",
        amount,
        invoiceUrl: r["Invoice Url"] || r["Invoice Link"] || "",
        matched2B: false,
        tally: false,
        isDeleted: false,
      });
    }

    if (!docs.length) {
      return res.json([]);
    }

    const created = await PurchaseRecord.insertMany(docs);
    res.json(created);
  } catch (err) {
    console.error("BULK UPLOAD ERROR:", err);
    res.status(500).json({ error: "Bulk upload failed" });
  }
});

module.exports = router;
