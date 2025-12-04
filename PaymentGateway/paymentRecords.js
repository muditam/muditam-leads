// ===========================
// routes/paymentRecords.js
// ===========================

const express = require("express");
const router = express.Router();

const mongoose = require("mongoose");
const multer = require("multer");
const AWS = require("aws-sdk");

const PaymentRecord = require("../models/PaymentRecord");
const PurchaseRecord = require("../models/PurchaseRecord");
const Vendor = require("../models/Vendor");

// ---------------------------------------------
// WASABI S3 CONFIG
// ---------------------------------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});

const upload = multer({ storage: multer.memoryStorage() });

async function calculateDueAtDate(targetDate, vendorName = null) {
  try {
    if (!targetDate) return 0;

    const baseDate = new Date(targetDate);
    if (isNaN(baseDate.getTime())) return 0;

    const endOfDay = new Date(baseDate);
    endOfDay.setHours(23, 59, 59, 999);

    const commonFilter = [
      { isDeleted: false },
      { isDeleted: null },
      { isDeleted: { $exists: false } }
    ];

    const invoiceMatch = {
      date: { $lte: endOfDay },
      vendorName,
      $or: commonFilter
    };

    const [invoiceAgg] = await PurchaseRecord.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } }
    ]);

    const totalInvoices = invoiceAgg?.total || 0;

    // -----------------------------
    // 2️⃣ PAYMENT TOTAL
    // -----------------------------
    const paymentMatch = {
      date: { $lte: endOfDay },
      vendorName,
      $or: commonFilter
    };

    const [paymentAgg] = await PaymentRecord.aggregate([
      { $match: paymentMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amountPaid", 0] } } } }
    ]);

    const totalPayments = paymentAgg?.total || 0;

    // -----------------------------
    // BASE DUE
    // -----------------------------
    return totalInvoices - totalPayments;
  } catch (err) {
    console.error("❌ Error calculating due:", err);
    return 0;
  }
}

/* ======================================================
   1️⃣ GET PAGINATED PAYMENT RECORDS
====================================================== */
router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const skip = (page - 1) * limit;

    const filter = {
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } }
      ]
    };

    const [records, total] = await Promise.all([
      PaymentRecord.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentRecord.countDocuments(filter)
    ]);

    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error("❌ Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch payment records" });
  }
});

/* ======================================================
   2️⃣ UNIQUE VENDOR LIST (Used in dropdowns)
====================================================== */
router.get("/vendor-list", async (req, res) => {
  try {
    const vendorsFromDB = await Vendor.find({}, { name: 1 }).lean();
    const vendorNames1 = vendorsFromDB.map(v => v.name);

    const vendorNames2 = await PurchaseRecord.distinct("vendorName");

    const merged = [...new Set([...vendorNames1, ...vendorNames2])].filter(Boolean);

    res.json(merged);
  } catch (err) {
    console.error("❌ Vendor list error:", err);
    res.status(500).json({ error: "Failed to load vendor list" });
  }
});

/* ======================================================
   3️⃣ FILE UPLOAD (WASABI)
====================================================== */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const filePath = `payment-records/${Date.now()}-${req.file.originalname}`;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: filePath,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: "public-read"
    };

    const uploaded = await s3.upload(params).promise();

    res.json({
      success: true,
      fileUrl: uploaded.Location,
      key: uploaded.Key
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ======================================================
   4️⃣ CREATE PAYMENT RECORD
   Snapshot Logic:
       dueAtThisDate = invoicesTillDate - (previousPayments + thisPayment)
====================================================== */
router.post("/", async (req, res) => {
  try {
    const vendorName = req.body.vendorName?.trim();
    const dateVal = req.body.date ? new Date(req.body.date) : null;
    const amountPaid = Number(req.body.amountPaid) || 0;

    let amountDue = 0;
    let dueAtThisDate = 0;

    // Only compute snapshot when complete info is present
    if (vendorName && dateVal && amountPaid > 0) {
      const baseDue = await calculateDueAtDate(dateVal, vendorName);

      const calc = baseDue - amountPaid;
      amountDue = calc;
      dueAtThisDate = calc;
    }

    const newRow = new PaymentRecord({
      date: dateVal,
      vendorName,
      amountPaid,
      amountDue,
      dueAtThisDate,
      screenshot: req.body.screenshot || "",
      isDeleted: false,
      deletedAt: null
    });

    const saved = await newRow.save();
    res.status(201).json(saved);
  } catch (err) {
    console.error("❌ Create error:", err);
    res.status(500).json({ error: "Failed to create payment record" });
  }
});

/* ======================================================
   5️⃣ UPDATE PAYMENT RECORD
====================================================== */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await PaymentRecord.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Record not found" });

    const updates = {};

    if (req.body.vendorName !== undefined)
      updates.vendorName = req.body.vendorName.trim();

    if (req.body.date !== undefined)
      updates.date = req.body.date ? new Date(req.body.date) : null;

    if (req.body.amountPaid !== undefined)
      updates.amountPaid = Number(req.body.amountPaid) || 0;

    if (req.body.screenshot !== undefined)
      updates.screenshot = req.body.screenshot;

    // Preserve snapshot unless it was originally 0
    updates.amountDue = existing.amountDue;
    updates.dueAtThisDate = existing.dueAtThisDate;

    // Step 1 — update first
    let updated = await PaymentRecord.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    // Step 2 — create snapshot if missing
    if (
      !existing.dueAtThisDate &&
      updated.vendorName &&
      updated.date &&
      updated.amountPaid > 0
    ) {
      const calc = await calculateDueAtDate(updated.date, updated.vendorName);

      updated.amountDue = calc;
      updated.dueAtThisDate = calc;
      await updated.save();
    }

    res.json(updated);
  } catch (err) {
    console.error("❌ Update error:", err);
    res.status(500).json({ error: "Failed to update record" });
  }
});

/* ======================================================
   6️⃣ SOFT DELETE PAYMENT RECORD
====================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PaymentRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );

    if (!deleted) return res.status(404).json({ error: "Record not found" });

    res.json({ message: "Deleted", record: deleted });
  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

module.exports = router;
