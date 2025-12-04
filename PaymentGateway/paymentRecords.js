// routes/paymentRecords.js
const express = require("express");
const router = express.Router();


const mongoose = require("mongoose");
const multer = require("multer");
const AWS = require("aws-sdk");


const PaymentRecord = require("../models/PaymentRecord");
const PurchaseRecord = require("../models/PurchaseRecord");
const Vendor = require("../models/Vendor");


// ---------- WASABI S3 CONFIG ----------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});


const upload = multer({ storage: multer.memoryStorage() });


/* ---------------------------------------------------
   🔥 DUE CALCULATION (BASE)
   Returns: dueBase = totalInvoices - totalPaymentsSavedUpToThisDate
--------------------------------------------------- */
async function calculateDueAtDate(targetDate, vendorName = null) {
  try {
    if (!targetDate) return 0;


    const baseDate = new Date(targetDate);
    if (Number.isNaN(baseDate.getTime())) return 0;


    const endOfDay = new Date(baseDate);
    endOfDay.setHours(23, 59, 59, 999);


    // 1️⃣ ALL invoices up to this date
    const invoiceMatch = {
      date: { $lte: endOfDay },
      vendorName,
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    };


    const [invoiceAgg] = await PurchaseRecord.aggregate([
      { $match: invoiceMatch },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]);


    const totalInvoices = invoiceAgg?.total || 0;


    // 2️⃣ ALL payments up to this date (all saved rows)
    const paymentMatch = {
      date: { $lte: endOfDay },
      vendorName,
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    };


    const [paymentAgg] = await PaymentRecord.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$amountPaid", 0] } },
        },
      },
    ]);


    const totalPayments = paymentAgg?.total || 0;


    return totalInvoices - totalPayments;
  } catch (err) {
    console.error("Error calculating due:", err);
    return 0;
  }
}


/* ---------------------------------------------
 * GET PAGINATED PAYMENT RECORDS
 * ------------------------------------------ */
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;


    const query = {
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    };


    const [records, total] = await Promise.all([
      PaymentRecord.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentRecord.countDocuments(query),
    ]);


    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch payment records" });
  }
});


/* ---------------------------------------------
 * UNIQUE VENDOR LIST
 * ------------------------------------------ */
router.get("/vendor-list", async (_req, res) => {
  try {
    const vendorDocs = await Vendor.find({}, { name: 1, _id: 0 })
      .sort({ createdAt: -1 })
      .lean();


    const vendorNames = vendorDocs.map((v) => v.name);
    const purchaseVendors = await PurchaseRecord.distinct("vendorName");


    const merged = Array.from(
      new Set([...vendorNames, ...purchaseVendors])
    ).filter(Boolean);


    res.json(merged);
  } catch (err) {
    console.error("Vendor list error:", err);
    res.status(500).json({ error: "Failed to load vendors" });
  }
});


/* ---------------------------------------------
 * FILE UPLOAD (Wasabi)
 * ------------------------------------------ */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }


    const fileName = `payment-records/${Date.now()}-${req.file.originalname}`;


    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: "public-read",
    };


    const result = await s3.upload(params).promise();


    res.json({
      success: true,
      fileUrl: result.Location,
      key: result.Key,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});


/* ---------------------------------------------
 * CREATE PAYMENT RECORD
 * Snapshot logic:
 *  - dueAtThisDate = invoicesTillDate - (allPreviousPayments + thisPayment)
 *  - Once set, it never changes.
 * ------------------------------------------ */
router.post("/", async (req, res) => {
  try {
    const vendorName = (req.body.vendorName || "").trim();
    const dateVal = req.body.date ? new Date(req.body.date) : null;
    const amountPaid = Number(req.body.amountPaid) || 0;


    let amountDue = 0;
    let dueAtThisDate = 0;


    // Lock snapshot only if full data is available
    if (vendorName && dateVal && amountPaid > 0) {
      // base due = invoices - ALL payments saved till this date (excluding current row)
      const baseDue = await calculateDueAtDate(dateVal, vendorName);


      // final due should INCLUDE this payment:
      // due = invoices - (previousPayments + thisPayment)
      const calc = baseDue - amountPaid;


      amountDue = calc;
      dueAtThisDate = calc;
    }


    const newRecord = new PaymentRecord({
      date: dateVal,
      vendorName,
      amountPaid,
      amountDue,
      dueAtThisDate,
      screenshot: req.body.screenshot || "",
      isDeleted: false,
      deletedAt: null,
    });


    const saved = await newRecord.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error("Create error:", error);
    res.status(500).json({ error: "Failed to create record" });
  }
});


/* ---------------------------------------------
 * UPDATE PAYMENT RECORD
 * - If snapshot already exists (dueAtThisDate != 0) → DON'T TOUCH IT
 * - If no snapshot yet (old rows / partial rows) → compute once using current data
 * ------------------------------------------ */
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await PaymentRecord.findById(id);


    if (!existing) {
      return res.status(404).json({ error: "Record not found" });
    }


    const updates = {};


    if (req.body.vendorName !== undefined)
      updates.vendorName = req.body.vendorName;


    if (req.body.date !== undefined)
      updates.date = req.body.date ? new Date(req.body.date) : null;


    if (req.body.amountPaid !== undefined)
      updates.amountPaid = Number(req.body.amountPaid) || 0;


    if (req.body.screenshot !== undefined)
      updates.screenshot = req.body.screenshot;


    // Preserve old snapshot by default
    updates.amountDue = existing.amountDue;
    updates.dueAtThisDate = existing.dueAtThisDate;


    // 1️⃣ Apply base update first
    let updated = await PaymentRecord.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });


    // 2️⃣ If snapshot NOT locked yet → compute once using updated row
    if (
      !existing.dueAtThisDate && // never had a snapshot before
      updated.vendorName &&
      updated.date &&
      updated.amountPaid > 0
    ) {
      // Here calculateDueAtDate already includes this updated row's payment
      const calc = await calculateDueAtDate(
        updated.date,
        updated.vendorName
      );


      updated.amountDue = calc;
      updated.dueAtThisDate = calc;


      await updated.save();
    }


    res.json(updated);
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ error: "Failed to update payment record" });
  }
});


/* ---------------------------------------------
 * SOFT DELETE PAYMENT RECORD
 * ------------------------------------------ */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;


    const deleted = await PaymentRecord.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );


    if (!deleted) {
      return res.status(404).json({ error: "Not found" });
    }


    res.json({ message: "Deleted", record: deleted });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete" });
  }
});


module.exports = router;



