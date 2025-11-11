const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const PurchaseRecord = require('../models/PurchaseRecord');
const PaymentRecord = require('../models/PaymentRecord');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ---------------- Wasabi S3 Client ----------------
const s3Client = new S3Client({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY,
  },
});

// ---------------- Multer (memory) + file filter ----------------
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    // allow jpg/jpeg/png/webp/heic/heif + pdf
    const allowedExt = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
    const allowedMime = /^(image\/jpeg|image\/png|image\/webp|image\/heic|image\/heif|application\/pdf)$/i;

    const hasGoodExt  = allowedExt.test(file.originalname);
    const hasGoodMime = allowedMime.test(file.mimetype);

    if (hasGoodExt && hasGoodMime) return cb(null, true);
    return cb(new Error('Only images (JPG/PNG/WEBP/HEIC) and PDF files are allowed!'));
  },
});

// Wrap Multer to return 400 on validation errors (instead of 500 HTML)
function multerWrap(mw) {
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: 'Upload failed', details: err.message || 'Invalid file' });
      }
      next();
    });
}

// ---------------- Helpers ----------------
async function putToWasabi(dirPrefix, file) {
  const fileKey = `${dirPrefix}/${Date.now()}-${file.originalname}`;
  const uploadParams = {
    Bucket: process.env.WASABI_BUCKET,
    Key: fileKey,
    Body: file.buffer,
    ACL: 'public-read',
    ContentType: file.mimetype,
  };
  const command = new PutObjectCommand(uploadParams);
  await s3Client.send(command);

  // Public URL
  return `https://${process.env.WASABI_BUCKET}.s3.${process.env.WASABI_REGION}.wasabisys.com/${fileKey}`;
}

/**
 * Calculate total due up to a target date.
 * Sums invoiceAmount from PurchaseRecord minus amountPaid from PaymentRecord
 * (optionally can be filtered by vendorName if needed later).
 */
async function calculateDueAtDate(targetDate, vendorName = null) {
  try {
    const date = new Date(targetDate);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const softNotDeleted = {
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };

    // Purchases up to date
    const invoiceMatch = { date: { $lte: endOfDay }, ...softNotDeleted };
    if (vendorName) invoiceMatch.partyName = vendorName;

    const totalInvoicesResult = await PurchaseRecord.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$invoiceAmount', 0] } } } },
    ]);
    const totalInvoices = totalInvoicesResult[0]?.total || 0;

    // Payments up to date
    const paymentMatch = { date: { $lte: endOfDay }, ...softNotDeleted };
    if (vendorName) paymentMatch.vendorName = vendorName;

    const totalPaymentsResult = await PaymentRecord.aggregate([
      { $match: paymentMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$amountPaid', 0] } } } },
    ]);
    const totalPayments = totalPaymentsResult[0]?.total || 0;

    return totalInvoices - totalPayments;
  } catch (err) {
    console.error('Error calculating due at date:', err);
    return 0;
  }
}

// ---------------- LIST ACTIVE (NOT DELETED) ----------------
router.get('/purchase-records', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip  = (page - 1) * limit;

    const query = {
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };

    if (req.query.category)      query.category = req.query.category;
    if (req.query.billingGst)    query.billingGst = req.query.billingGst;
    if (req.query.paymentStatus) query.paymentStatus = req.query.paymentStatus;
    if (req.query.vendorSearch)  query.partyName = { $regex: req.query.vendorSearch, $options: 'i' };

    const [records, total] = await Promise.all([
      PurchaseRecord.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      PurchaseRecord.countDocuments(query),
    ]);

    return res.json({ records, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching purchase records:', error);
    return res.status(500).json({ error: 'Failed to fetch records' });
  }
});


// ---------------- LIST DELETED ONLY ----------------
router.get('/deleted-records', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip  = (page - 1) * limit;

    const query = { isDeleted: true };
    if (req.query.category)      query.category = req.query.category;
    if (req.query.billingGst)    query.billingGst = req.query.billingGst;
    if (req.query.paymentStatus) query.paymentStatus = req.query.paymentStatus;
    if (req.query.vendorSearch)  query.partyName = { $regex: req.query.vendorSearch, $options: 'i' };

    const [records, total] = await Promise.all([
      PurchaseRecord.find(query).sort({ deletedAt: -1 }).skip(skip).limit(limit).lean().exec(),
      PurchaseRecord.countDocuments(query),
    ]);

    return res.json({ records, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching deleted records:', error);
    return res.status(500).json({ error: 'Failed to fetch deleted records' });
  }
});

// ---------------- SOFT DELETE ----------------
router.delete('/purchase-records/:id', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );

    if (!record) return res.status(404).json({ error: 'Record not found' });
    return res.json({ message: 'Record moved to deleted records', record });
  } catch (error) {
    console.error('Error deleting record:', error);
    return res.status(500).json({ error: 'Failed to delete record' });
  }
});

// ---------------- RESTORE ----------------
router.patch('/deleted-records/:id/restore', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: false, deletedAt: null },
      { new: true }
    );

    if (!record) return res.status(404).json({ error: 'Record not found' });
    return res.json({ message: 'Record restored successfully', record });
  } catch (error) {
    console.error('Error restoring record:', error);
    return res.status(500).json({ error: 'Failed to restore record' });
  }
});

// ---------------- PERMANENT DELETE ----------------
router.delete('/deleted-records/:id/permanent', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndDelete(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    return res.json({ message: 'Record permanently deleted' });
  } catch (error) {
    console.error('Error permanently deleting record:', error);
    return res.status(500).json({ error: 'Failed to permanently delete record' });
  }
});

// ---------------- CREATE ----------------
router.post('/purchase-records', async (req, res) => {
  try {
    const recordData = {
      ...req.body,
      date: req.body.date || new Date(),
      dueAtThisDate: 0, // calculated on first relevant update
      updatedAt: new Date(),
    };

    const record = new PurchaseRecord(recordData);
    await record.save();
    return res.status(201).json(record);
  } catch (error) {
    console.error('Error creating purchase record:', error);
    return res.status(400).json({ error: error.message });
  }
});

// ---------------- UPDATE (non-retroactive due calc) ----------------
router.patch('/purchase-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updatedAt: new Date() };

    const existingRecord = await PurchaseRecord.findById(id);
    if (!existingRecord) return res.status(404).json({ error: 'Record not found' });

    const updatedState = {
      partyName: updates.partyName ?? existingRecord.partyName,
      date:      updates.date      ?? existingRecord.date,
    };

    // Calculate once: when dueAtThisDate is still 0 and we have date (+ optional partyName)
    const shouldCalculateDue =
      existingRecord.dueAtThisDate === 0 &&
      updatedState.date;

    if (shouldCalculateDue) {
      const recordDate = new Date(updatedState.date);
      const dueAtThisDate = await calculateDueAtDate(recordDate /*, updatedState.partyName */);
      updates.dueAtThisDate = dueAtThisDate;
    } else {
      delete updates.dueAtThisDate;
    }

    const record = await PurchaseRecord.findByIdAndUpdate(id, updates, { new: true });
    return res.json(record);
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ---------------- WASABI GENERIC UPLOAD ----------------
router.post(
  '/uploadToWasabi',
  multerWrap(upload.single('file')),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const fileUrl = await putToWasabi('purchase-records', req.file);

      const recordId = req.body.recordId;
      const field = req.body.field || 'paymentScreenshot';

      if (recordId) {
        await PurchaseRecord.findByIdAndUpdate(recordId, {
          [field]: fileUrl,
          updatedAt: new Date(),
        });
      }

      return res.json({ fileUrl, url: fileUrl });
    } catch (error) {
      console.error('Wasabi upload error:', error);
      return res.status(500).json({ error: 'Upload failed', details: error.message });
    }
  }
);

router.get('/purchase-records/:id', async (req, res) => {
  try {
    const record = await PurchaseRecord.findById(req.params.id).lean();
    if (!record) return res.status(404).json({ error: 'Record not found' });
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- SPECIFIC PAYMENT SCREENSHOT UPLOAD ----------------
router.post(
  '/upload-payment-screenshot',
  multerWrap(upload.single('file')),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const fileUrl = await putToWasabi('payment-screenshots', req.file);

      if (req.body.recordId) {
        await PurchaseRecord.findByIdAndUpdate(req.body.recordId, {
          paymentScreenshot: fileUrl,
          updatedAt: new Date(),
        });
      }

      return res.json({ message: 'File uploaded successfully', fileUrl });
    } catch (error) {
      console.error('Error uploading file:', error);
      return res.status(500).json({ error: 'Upload failed', details: error.message });
    }
  }
);

module.exports = router;
