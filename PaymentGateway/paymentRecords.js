// routes/paymentRecords.js
const express = require("express");
const router = express.Router();

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

/* ---------------------------------------------------
   🔥 DUE CALCULATION (BASE) - FIXED
   Returns: dueBase = totalInvoices - totalPaymentsSavedUpToThisDate
--------------------------------------------------- */
async function calculateDueAtDate(targetDate, vendorName = null) {
  try {
    if (!targetDate || !vendorName) return 0;

    const baseDate = new Date(targetDate);
    if (Number.isNaN(baseDate.getTime())) return 0;

    const endOfDay = new Date(baseDate);
    endOfDay.setHours(23, 59, 59, 999);

    const commonFilter = [
      { isDeleted: false },
      { isDeleted: null },
      { isDeleted: { $exists: false } },
    ];

    // 1️⃣ INVOICES - WRAPPED IN TRY-CATCH
    let totalInvoices = 0;
    try {
      const invoiceMatch = {
        date: { $lte: endOfDay },
        vendorName,
        $or: commonFilter,
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

      totalInvoices = invoiceAgg?.total || 0;
    } catch (invoiceErr) {
      console.error("Invoice aggregation error:", invoiceErr.message);
      totalInvoices = 0;
    }

    // 2️⃣ PAYMENTS - WRAPPED IN TRY-CATCH
    let totalPayments = 0;
    try {
      const paymentMatch = {
        date: { $lte: endOfDay },
        vendorName,
        $or: commonFilter,
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

      totalPayments = paymentAgg?.total || 0;
    } catch (paymentErr) {
      console.error("Payment aggregation error:", paymentErr.message);
      totalPayments = 0;
    }

    // BASE DUE
    return totalInvoices - totalPayments;
  } catch (err) {
    console.error("Error calculating due:", err.message);
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
    console.error("Fetch payment records error:", error.message);
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
    console.error("Vendor list error:", err.message);
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
    console.error("Upload error:", error.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ---------------------------------------------
 * CREATE PAYMENT RECORD - FIXED
 * Snapshot logic:
 *  - baseDue = invoicesTillDate - paymentsTillDate (excluding this)
 *  - final due = baseDue - thisPayment
 * ------------------------------------------ */
router.post("/", async (req, res) => {
  try {
    const vendorName = (req.body.vendorName || "").trim();
    const dateVal = req.body.date ? new Date(req.body.date) : null;
    const amountPaid = Number(req.body.amountPaid) || 0;

    let amountDue = 0;
    let dueAtThisDate = 0;

    // CRITICAL FIX: Wrap calculation in try-catch
    if (vendorName && dateVal && amountPaid > 0) {
      try {
        const baseDue = await calculateDueAtDate(dateVal, vendorName);
        const calc = baseDue - amountPaid;
        amountDue = calc;
        dueAtThisDate = calc;
      } catch (calcErr) {
        console.error("Due calculation failed:", calcErr.message);
        // Continue with 0 values - don't crash
        amountDue = 0;
        dueAtThisDate = 0;
      }
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
    console.error("Create payment record error:", error.message);
    res.status(500).json({ 
      error: "Failed to create record",
      message: error.message 
    });
  }
});

/* ---------------------------------------------
 * UPDATE PAYMENT RECORD - FIXED
 * - If snapshot already exists → don't touch
 * - If no snapshot → compute once using updated row
 * ------------------------------------------ */
router.patch("/:id", async (req, res) => {
  try {
    const existing = await PaymentRecord.findById(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: "Record not found" });
    }

    const updates = {};

    if (req.body.vendorName !== undefined)
      updates.vendorName = (req.body.vendorName || "").trim();

    if (req.body.date !== undefined)
      updates.date = req.body.date ? new Date(req.body.date) : null;

    if (req.body.amountPaid !== undefined)
      updates.amountPaid = Number(req.body.amountPaid) || 0;

    if (req.body.screenshot !== undefined)
      updates.screenshot = req.body.screenshot;

    // keep old snapshot by default
    updates.amountDue = existing.amountDue;
    updates.dueAtThisDate = existing.dueAtThisDate;

    let updated = await PaymentRecord.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    );

    // CRITICAL FIX: Wrap recalculation in try-catch
    if (
      !existing.dueAtThisDate &&
      updated.vendorName &&
      updated.date &&
      updated.amountPaid > 0
    ) {
      try {
        const calc = await calculateDueAtDate(updated.date, updated.vendorName);
        updated.amountDue = calc;
        updated.dueAtThisDate = calc;
        await updated.save();
      } catch (calcErr) {
        console.error("Due recalculation failed:", calcErr.message);
        // Continue without recalculation - don't crash
      }
    }

    res.json(updated);
  } catch (error) {
    console.error("Update payment record error:", error.message);
    res.status(500).json({ 
      error: "Failed to update payment record",
      message: error.message 
    });
  }
});

/* ---------------------------------------------
 * SOFT DELETE PAYMENT RECORD
 * ------------------------------------------ */
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PaymentRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );

    if (!deleted) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({ message: "Deleted", record: deleted });
  } catch (error) {
    console.error("Delete payment record error:", error.message);
    res.status(500).json({ error: "Failed to delete" });
  }
});

module.exports = router;