// routes/paymentRecords.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PaymentRecord = require('../models/PaymentRecord');
const PurchaseRecord = require('../models/PurchaseRecord');

// ---------- Utils ----------
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

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

// ---------- Upload setup (local, ephemeral on Heroku) ----------
const uploadDir = path.join(__dirname, '..', 'uploads', 'payment-screenshots');
fs.mkdirSync(uploadDir, { recursive: true });

const safeBaseName = (original) => {
  const parsed = path.parse(original);
  const base = (parsed.base || 'file').replace(/\s+/g, '_').replace(/[^\w.\-]/g, '');
  return base || `upload-${Date.now()}.bin`;
};

// Restrict to common image/PDF types (you can relax this if needed)
const fileFilter = (_req, file, cb) => {
  const okMime = /^(image\/jpeg|image\/png|image\/webp|application\/pdf)$/i.test(file.mimetype);
  const okExt = /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname || '');
  if (okMime && okExt) return cb(null, true);
  cb(new Error('Only JPG/PNG/WEBP/PDF files are allowed'));
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${safeBaseName(file.originalname || 'upload')}`),
});

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- Due calculator (EOD) ----------
async function calculateDueAtDate(targetDate, vendorName = null, excludePaymentId = null) {
  try {
    const date = new Date(targetDate);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const softNotDeleted = {
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };

    const invoiceMatch = { date: { $lte: endOfDay }, ...softNotDeleted };
    if (vendorName) invoiceMatch.partyName = vendorName;

    const totalInvoicesResult = await PurchaseRecord.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$invoiceAmount', 0] } } } },
    ]);
    const totalInvoices = totalInvoicesResult[0]?.total || 0;

    const paymentMatch = { date: { $lte: endOfDay }, ...softNotDeleted };
    if (vendorName) paymentMatch.vendorName = vendorName;
    if (excludePaymentId && isObjectId(excludePaymentId)) {
      paymentMatch._id = { $ne: new mongoose.Types.ObjectId(excludePaymentId) };
    }

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

// ---------- GET all active (not deleted) ----------
router.get('/', async (req, res) => {
  try {
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
    const skip = (page - 1) * limit;

    const query = {
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };

    const [records, total] = await Promise.all([
      PaymentRecord.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      PaymentRecord.countDocuments(query),
    ]);

    res.json({ records, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching payment records:', error);
    res.status(500).json({ error: 'Failed to fetch payment records' });
  }
});

// ---------- POST create (optional screenshot) ----------
router.post('/', upload.single('screenshot'), async (req, res) => {
  try {
    const screenshotUrl = req.file
      ? `/uploads/payment-screenshots/${path.basename(req.file.filename)}`
      : (req.body.screenshot || '');

    const doc = {
      date: toDateOrNull(req.body.date),
      vendorName: (req.body.vendorName || '').trim(),
      amountPaid: toNumber(req.body.amountPaid, 0),
      amountDue: 0,
      dueAtThisDate: 0,
      screenshot: screenshotUrl,
      isDeleted: false,
    };

    const created = await PaymentRecord.create(doc);
    res.status(201).json(created);
  } catch (error) {
    console.error('Create error:', error);
    const code = /allowed/i.test(String(error?.message || '')) ? 400 : 500;
    res.status(code).json({ error: 'Failed to create payment record', details: error.message });
  }
});

// ---------- PATCH update (replace screenshot if present) ----------
router.patch('/:id', upload.single('screenshot'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const existingRecord = await PaymentRecord.findById(id);
    if (!existingRecord) return res.status(404).json({ error: 'Payment record not found' });

    const updates = {};
    if (req.body.vendorName !== undefined) updates.vendorName = String(req.body.vendorName || '').trim();
    if (req.body.date !== undefined) updates.date = toDateOrNull(req.body.date);
    if (req.body.amountPaid !== undefined) updates.amountPaid = toNumber(req.body.amountPaid, 0);
    if (req.file) updates.screenshot = `/uploads/payment-screenshots/${path.basename(req.file.filename)}`;

    // Keep immutable lock semantics
    const isLocked = Number(existingRecord.dueAtThisDate || 0) !== 0;

    if (isLocked) {
      // never modify locked due fields
      delete updates.dueAtThisDate;
      delete updates.amountDue;
    } else {
      const willSetAmountPaid =
        Object.prototype.hasOwnProperty.call(updates, 'amountPaid') &&
        updates.amountPaid !== null &&
        updates.amountPaid !== undefined;

      // Prepare aggregate state after this update
      const nextVendor = updates.vendorName ?? existingRecord.vendorName;
      const nextDate = updates.date ?? existingRecord.date;

      if (willSetAmountPaid && nonEmpty(nextVendor) && nextDate instanceof Date) {
        // Step 1: persist amountPaid first
        const amountPaidValue = updates.amountPaid;
        await PaymentRecord.findByIdAndUpdate(id, { $set: { amountPaid: amountPaidValue } });

        // Step 2: compute due including the just-saved payment
        const calculatedDue = await calculateDueAtDate(nextDate, nextVendor);

        // Step 3: lock fields
        updates.dueAtThisDate = calculatedDue;
        updates.amountDue = calculatedDue;
        updates.amountPaid = amountPaidValue; // keep in updates payload too
      } else {
        delete updates.dueAtThisDate;
        delete updates.amountDue;
      }
    }

    const updated = await PaymentRecord.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json(updated);
  } catch (error) {
    console.error('❌ Error updating payment record:', error);
    const code = /allowed/i.test(String(error?.message || '')) ? 400 : 500;
    res.status(code).json({ error: 'Failed to update payment record', details: error.message });
  }
});

// ---------- DELETE (soft) ----------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PaymentRecord.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );

    if (!record) return res.status(404).json({ error: 'Payment record not found' });
    res.json({ message: 'Payment record deleted', record });
  } catch (error) {
    console.error('Error deleting payment record:', error);
    res.status(500).json({ error: 'Failed to delete payment record' });
  }
});

// ---------- GET deleted ----------
router.get('/deleted', async (req, res) => {
  try {
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
    const skip = (page - 1) * limit;

    const query = { isDeleted: true };

    const [records, total] = await Promise.all([
      PaymentRecord.find(query).sort({ deletedAt: -1 }).skip(skip).limit(limit).lean().exec(),
      PaymentRecord.countDocuments(query),
    ]);

    res.json({ records, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching deleted payment records:', error);
    res.status(500).json({ error: 'Failed to fetch deleted payment records' });
  }
});

// ---------- PATCH restore ----------
router.patch('/deleted/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid record id' });

    const record = await PaymentRecord.findByIdAndUpdate(
      id,
      { isDeleted: false, deletedAt: null },
      { new: true }
    );

    if (!record) return res.status(404).json({ error: 'Payment record not found' });
    res.json({ message: 'Payment record restored successfully', record });
  } catch (error) {
    console.error('Error restoring payment record:', error);
    res.status(500).json({ error: 'Failed to restore payment record' });
  }
});

module.exports = router;
