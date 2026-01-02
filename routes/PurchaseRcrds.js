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

// ----------------------
// BOOLEAN PARSER
// YES / TRUE / 1  -> true
// anything else   -> false
// ----------------------
function parseBoolean(val) {
  if (val === true) return true;
  if (!val) return false;

  const s = String(val).toLowerCase().trim();
  return ["yes", "true", "1", "y"].includes(s);
}

// ----------------------
// AMOUNT PARSER
// Handles: "1,200", "₹1,200", "", null, numbers
// Returns a safe number (defaults to 0)
// ----------------------
function parseAmount(val) {
  if (val === null || val === undefined) return 0;

  if (typeof val === "number") return Number.isFinite(val) ? val : 0;

  const s = String(val).trim();
  if (!s) return 0;

  const cleaned = s.replace(/[,₹\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------
// DATE NORMALIZER
// - Excel date serial (number) -> real Date
// - JS Date -> Date
// - String (yyyy-mm-dd or parseable) -> Date
// If invalid/missing -> fallback
// ----------------------
function normalizeDate(val, fallback) {
  if (!val) return fallback;

  // already a JS Date
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val;

  // Excel serial number (e.g. 45808)
  if (typeof val === "number") {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
    return fallback;
  }

  // string date
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return fallback;

    // yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(`${s}T00:00:00.000Z`);
    }

    // general parse
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }

  return fallback;
}

// -----------------------------------------------------
// GET ALL PURCHASE RECORDS
// -----------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find({ isDeleted: { $ne: true } }).sort({
      createdAt: -1,
    });

    return res.json(records);
  } catch (err) {
    console.error("GET /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// -----------------------------------------------------
// CREATE SINGLE RECORD
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
    const updated = await PurchaseRecord.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });

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
// UPLOAD INVOICE (WASABI)
// -----------------------------------------------------
router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

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
 
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const workbook = XLSX.read(req.file.buffer, {
      type: "buffer",
      cellDates: true,
    });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const defaultDate = req.body.date
      ? new Date(`${String(req.body.date).slice(0, 10)}T00:00:00.000Z`)
      : new Date();

    const createdList = [];

    for (const r of rows) {
      const entry = await PurchaseRecord.create({
        date: normalizeDate(r["Date"], defaultDate),

        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",
        vendorName: r["Vendor Name"] || "",

        // ✅ fixed NaN issue
        amount: parseAmount(r["Amount"]),

        invoiceUrl: r["Invoice Link"] || "",
        matched2B: parseBoolean(r["Matched 2B"]),
        tally: parseBoolean(r["Tally"]),

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

module.exports = router;
