// routes/purchase-records.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const AWS = require("aws-sdk");
const mongoose = require("mongoose");

const PurchaseRecord = require("../models/PurchaseRcrd");
const Vendor = require("../models/Vendorname");

// ----------------------
// MULTER SETUP
// ----------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

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
// HELPERS
// ----------------------
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeVendorKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// matches vendorName robustly even if spaces/case differ a bit
function vendorNameFlexibleRegex(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const pattern = `^\\s*${parts.map(escapeRegExp).join("\\s+")}\\s*$`;
  return new RegExp(pattern, "i");
}

function parsePageLimit(req) {
  const pageRaw = req.query.page;
  const limitRaw = req.query.limit;

  const page = Number.isFinite(Number(pageRaw)) ? Math.max(0, parseInt(pageRaw, 10)) : 0;
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(200, Math.max(1, parseInt(limitRaw, 10))) : 10;

  return { page, limit };
}

function dayRangeUTC(yyyyMmDd) {
  const start = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  const end = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function parseBoolean(val) {
  if (val === true) return true;
  if (!val) return false;
  const s = String(val).toLowerCase().trim();
  return ["yes", "true", "1", "y"].includes(s);
}

function parseAmount(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;

  const s = String(val).trim();
  if (!s) return 0;

  const cleaned = s.replace(/[,₹\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDate(val, fallback) {
  if (!val) return fallback;

  if (val instanceof Date && !Number.isNaN(val.getTime())) return val;

  if (typeof val === "number") {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
    return fallback;
  }

  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return fallback;

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(`${s}T00:00:00.000Z`);
    }

    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }

  return fallback;
}

// Resolve vendorName/vendorId so data stays consistent (helps filtering + old rows)
async function resolveVendorFields(patch) {
  const out = { ...patch };

  const incomingVendorId = out.vendorId ?? null;
  const incomingVendorName = typeof out.vendorName === "string" ? out.vendorName.trim() : "";

  // If vendorId provided but vendorName missing → fill vendorName
  if (incomingVendorId && !incomingVendorName) {
    const idStr = String(incomingVendorId);
    if (mongoose.Types.ObjectId.isValid(idStr)) {
      const v = await Vendor.findById(idStr, { name: 1 }).lean();
      if (v?.name) out.vendorName = v.name;
    }
  }

  // If vendorName provided but vendorId missing → try match vendorId
  if (!incomingVendorId && incomingVendorName) {
    const key = normalizeVendorKey(incomingVendorName);
    // try exact match by normalized key using regex (no schema changes)
    const rx = vendorNameFlexibleRegex(incomingVendorName);
    const v = await Vendor.findOne(rx ? { name: rx } : { name: incomingVendorName }, { _id: 1, name: 1 }).lean();
    if (v?._id) out.vendorId = v._id;
    if (v?.name) out.vendorName = v.name; // normalize to stored vendor name
  }

  // If vendorId explicitly set to null → also clear vendorName if not set
  if (incomingVendorId === null && !("vendorName" in out)) {
    out.vendorName = "";
  }

  return out;
}

// -----------------------------------------------------
// GET PURCHASE RECORDS (SERVER-SIDE FILTERS + PAGINATION)
// Supports:
// - page, limit
// - showDeleted=true (only deleted; else only non-deleted)
// - vendorId (matches ObjectId OR string-stored ids)
// - vendorName (flex exact match; also supports old rows)
// - invoiceNo (contains, case-insensitive)
// - amount (exact)
// - date=YYYY-MM-DD (matches Date OR string/ISO string)
// -----------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { page, limit } = parsePageLimit(req);

    const showDeleted = String(req.query.showDeleted || "").toLowerCase() === "true";

    const vendorId = String(req.query.vendorId || "").trim();
    const vendorName = String(req.query.vendorName || "").trim();
    const invoiceNo = String(req.query.invoiceNo || "").trim();
    const amountRaw = String(req.query.amount ?? "").trim();
    const dateRaw = String(req.query.date || "").trim(); // YYYY-MM-DD

    const and = [];

    // deleted filter
    and.push(showDeleted ? { isDeleted: true } : { isDeleted: { $ne: true } });

    // ✅ vendor filter: match vendorId (ObjectId OR string) OR vendorName (flex exact)
    if (vendorId || vendorName) {
      const vendorOr = [];

      if (vendorId) {
        if (!mongoose.Types.ObjectId.isValid(vendorId)) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const oid = new mongoose.Types.ObjectId(vendorId);
        vendorOr.push({ vendorId: oid });       // normal
        vendorOr.push({ vendorId: vendorId });  // old rows where vendorId was stored as string
      }

      if (vendorName) {
        const rx = vendorNameFlexibleRegex(vendorName);
        if (rx) vendorOr.push({ vendorName: rx });
        else vendorOr.push({ vendorName: vendorName });
      }

      if (vendorOr.length === 1) and.push(vendorOr[0]);
      else if (vendorOr.length > 1) and.push({ $or: vendorOr });
    }

    // invoiceNo (contains)
    if (invoiceNo) {
      and.push({ invoiceNo: { $regex: escapeRegExp(invoiceNo), $options: "i" } });
    }

    // amount (exact number)
    if (amountRaw !== "") {
      const n = Number(amountRaw);
      if (Number.isFinite(n)) and.push({ amount: n });
    }

    // date (single day) supports Date + string storage
    if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      const { start, end } = dayRangeUTC(dateRaw);
      and.push({
        $or: [
          { date: { $gte: start, $lt: end } }, // Date
          { date: dateRaw },                   // string: "YYYY-MM-DD"
          { date: { $regex: `^${escapeRegExp(dateRaw)}`, $options: "i" } }, // string ISO: "YYYY-MM-DDT..."
        ],
      });
    }

    const query = and.length ? { $and: and } : {};
    const skip = page * limit;

    const [items, total] = await Promise.all([
      PurchaseRecord.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PurchaseRecord.countDocuments(query),
    ]);

    const hasMore = skip + items.length < total;

    return res.json({ items, total, page, limit, hasMore });
  } catch (err) {
    console.error("GET /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// -----------------------------------------------------
// CREATE SINGLE RECORD (auto resolves vendorName/vendorId)
// -----------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const payload = await resolveVendorFields(req.body || {});
    const created = await PurchaseRecord.create(payload);
    return res.json(created);
  } catch (err) {
    console.error("POST /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// -----------------------------------------------------
// UPDATE RECORD (auto resolves vendorName/vendorId)
// -----------------------------------------------------
router.patch("/:id", async (req, res) => {
  try {
    const patch = await resolveVendorFields(req.body || {});

    const updated = await PurchaseRecord.findByIdAndUpdate(req.params.id, patch, {
      new: true,
    });

    if (!updated) return res.status(404).json({ error: "Record not found" });
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

    if (!deleted) return res.status(404).json({ error: "Record not found" });
    return res.json(deleted);
  } catch (err) {
    console.error("DELETE /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to delete record" });
  }
});

// -----------------------------------------------------
// UPLOAD INVOICE (WASABI)
// -----------------------------------------------------
router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

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
// BULK UPLOAD (CSV/EXCEL)
// ✅ fast: insertMany instead of create in loop
// ✅ sets vendorId by matching vendorName
// -----------------------------------------------------
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // vendor map once
    const vendors = await Vendor.find({}, { _id: 1, name: 1 }).lean();
    const vendorMap = new Map();
    for (const v of vendors) vendorMap.set(normalizeVendorKey(v.name), v);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const defaultDate = req.body.date
      ? new Date(`${String(req.body.date).slice(0, 10)}T00:00:00.000Z`)
      : new Date();

    // build docs
    const docs = rows.map((r) => {
      const rawVendorName = String(r["Vendor Name"] || "").trim();
      const matchedVendor = vendorMap.get(normalizeVendorKey(rawVendorName));

      return {
        date: normalizeDate(r["Date"], defaultDate),

        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",

        vendorName: matchedVendor?.name || rawVendorName || "",
        vendorId: matchedVendor?._id || null,

        amount: parseAmount(r["Amount"]),
        invoiceUrl: r["Invoice Link"] || "",
        matched2B: parseBoolean(r["Matched 2B"]),
        tally: parseBoolean(r["Tally"]),

        isDeleted: false,
      };
    });

    // fast insert
    const inserted = await PurchaseRecord.insertMany(docs, { ordered: false });

    return res.json({
      success: true,
      count: inserted.length,
      records: inserted,
    });
  } catch (err) {
    console.error("Bulk Upload Error:", err);
    return res.status(500).json({ error: "Bulk upload failed" });
  }
});

module.exports = router;
