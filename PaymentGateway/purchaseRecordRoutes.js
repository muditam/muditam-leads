// routes/purchaseRecords.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const PurchaseRecord = require('../models/PurchaseRecord');
const PaymentRecord = require('../models/PaymentRecord');

// ---------------- Helpers ----------------
const isObjectId = (v) =>
  typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);

const toNumber = (v, def = 0) => {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const toDateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const trimOrEmpty = (v) => (typeof v === 'string' ? v.trim() : (v ?? ''));

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
  fileFilter: (_req, file, cb) => {
    // allow jpg/jpeg/png/webp/heic/heif + pdf
    const allowedExt = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
    const allowedMime = /^(image\/jpeg|image\/png|image\/webp|image\/heic|image\/heif|application\/pdf)$/i;

    const hasGoodExt = allowedExt.test(file.originalname || '');
    const hasGoodMime = allowedMime.test(file.mimetype || '');

    if (hasGoodExt && hasGoodMime) return cb(null, true);
    return cb(new Error('Only images (JPG/PNG/WEBP/HEIC) and PDF files are allowed!'));
  },
});

// Wrap Multer to return 400 on validation errors (instead of 500 HTML)
function multerWrap(mw) {
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        return res
          .status(400)
          .json({ error: 'Upload failed', details: err.message || 'Invalid file' });
      }
      next();
    });
}

// Sanitize filenames for S3 keys
function safeBaseName(name = 'upload.bin') {
  return String(name).replace(/\s+/g, '_').replace(/[^\w.\-]/g, '');
}

// ---------------- Wasabi upload helper ----------------
async function putToWasabi(dirPrefix, file) {
  const keySafe = safeBaseName(file.originalname || 'upload.bin');
  const fileKey = `${dirPrefix}/${Date.now()}-${keySafe}`;
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
 * (optionally filtered by vendorName if needed).
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
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
    const skip = (page - 1) * limit;

    const query = {
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };

    if (req.query.category) query.category = trimOrEmpty(req.query.category);
    if (req.query.billingGst) query.billingGst = trimOrEmpty(req.query.billingGst);
    if (req.query.paymentStatus) query.paymentStatus = trimOrEmpty(req.query.paymentStatus);
    if (req.query.vendorSearch) {
      const s = String(req.query.vendorSearch || '').trim();
      if (s) query.partyName = { $regex: s, $options: 'i' };
    }

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
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
    const skip = (page - 1) * limit;

    const query = { isDeleted: true };
    if (req.query.category) query.category = trimOrEmpty(req.query.category);
    if (req.query.billingGst) query.billingGst = trimOrEmpty(req.query.billingGst);
    if (req.query.paymentStatus) query.paymentStatus = trimOrEmpty(req.query.paymentStatus);
    if (req.query.vendorSearch) {
      const s = String(req.query.vendorSearch || '').trim();
      if (s) query.partyName = { $regex: s, $options: 'i' };
    }

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
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PurchaseRecord.findByIdAndUpdate(
      id,
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
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PurchaseRecord.findByIdAndUpdate(
      id,
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
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PurchaseRecord.findByIdAndDelete(id);
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
    const body = req.body || {};
    const recordData = {
      date: toDateOrNull(body.date) || new Date(),
      category: trimOrEmpty(body.category),
      invoiceType: trimOrEmpty(body.invoiceType),
      billingGst: trimOrEmpty(body.billingGst),
      invoiceNo: trimOrEmpty(body.invoiceNo),
      partyName: trimOrEmpty(body.partyName),
      invoiceAmount: toNumber(body.invoiceAmount, 0),
      physicalInvoice: body.physicalInvoice || 'No',
      link: trimOrEmpty(body.link),
      matchedWith2B: body.matchedWith2B || 'No',
      invoicingTally: body.invoicingTally || 'No',
      vendorEmail: trimOrEmpty(body.vendorEmail),
      vendorPhone: trimOrEmpty(body.vendorPhone),
      paymentDate: toDateOrNull(body.paymentDate),
      dueAtThisDate: 0, // calculated on first relevant update
      isDeleted: false,
      deletedAt: null,
      updatedAt: new Date(),
    };

    const record = await PurchaseRecord.create(recordData);
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
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const body = req.body || {};
    const updates = {
      updatedAt: new Date(),
    };

    // Coerce/trim only provided fields
    if ('date' in body) updates.date = toDateOrNull(body.date);
    if ('category' in body) updates.category = trimOrEmpty(body.category);
    if ('invoiceType' in body) updates.invoiceType = trimOrEmpty(body.invoiceType);
    if ('billingGst' in body) updates.billingGst = trimOrEmpty(body.billingGst);
    if ('invoiceNo' in body) updates.invoiceNo = trimOrEmpty(body.invoiceNo);
    if ('partyName' in body) updates.partyName = trimOrEmpty(body.partyName);
    if ('invoiceAmount' in body) updates.invoiceAmount = toNumber(body.invoiceAmount, 0);
    if ('physicalInvoice' in body) updates.physicalInvoice = body.physicalInvoice || '';
    if ('link' in body) updates.link = trimOrEmpty(body.link);
    if ('matchedWith2B' in body) updates.matchedWith2B = body.matchedWith2B || '';
    if ('invoicingTally' in body) updates.invoicingTally = body.invoicingTally || '';
    if ('vendorEmail' in body) updates.vendorEmail = trimOrEmpty(body.vendorEmail);
    if ('vendorPhone' in body) updates.vendorPhone = trimOrEmpty(body.vendorPhone);
    if ('paymentDate' in body) updates.paymentDate = toDateOrNull(body.paymentDate);

    const existingRecord = await PurchaseRecord.findById(id);
    if (!existingRecord) return res.status(404).json({ error: 'Record not found' });

    const nextDate = updates.date ?? existingRecord.date;
    // Calculate once: when dueAtThisDate is still 0 and we have a valid date
    const shouldCalculateDue = (existingRecord.dueAtThisDate || 0) === 0 && nextDate instanceof Date;

    if (shouldCalculateDue) {
      const dueAtThisDate = await calculateDueAtDate(nextDate /*, (updates.partyName ?? existingRecord.partyName) */);
      updates.dueAtThisDate = dueAtThisDate;
    } else {
      delete updates.dueAtThisDate;
    }

    const record = await PurchaseRecord.findByIdAndUpdate(id, { $set: updates }, { new: true });
    return res.json(record);
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ---------------- WASABI GENERIC UPLOAD ----------------
router.post('/uploadToWasabi', multerWrap(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileUrl = await putToWasabi('purchase-records', req.file);

    const recordId = req.body.recordId;
    const field = req.body.field || 'paymentScreenshot';

    if (recordId && isObjectId(recordId)) {
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
});

// ---------------- GET by ID ----------------
router.get('/purchase-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PurchaseRecord.findById(id).lean();
    if (!record) return res.status(404).json({ error: 'Record not found' });
    res.json(record);
  } catch (e) {
    console.error('Get record error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------- SPECIFIC PAYMENT SCREENSHOT UPLOAD ----------------
router.post('/upload-payment-screenshot', multerWrap(upload.single('file')), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileUrl = await putToWasabi('payment-screenshots', req.file);

    const recordId = req.body.recordId;
    if (recordId && isObjectId(recordId)) {
      await PurchaseRecord.findByIdAndUpdate(recordId, {
        paymentScreenshot: fileUrl,
        updatedAt: new Date(),
      });
    }

    return res.json({ message: 'File uploaded successfully', fileUrl });
  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

module.exports = router;
