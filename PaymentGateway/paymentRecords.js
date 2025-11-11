const express = require('express');
const router = express.Router();
const PaymentRecord = require('../models/PaymentRecord');
const PurchaseRecord = require('../models/PurchaseRecord');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


// Ensure directory exists
const uploadDir = path.join(__dirname, '..', 'uploads', 'payment-screenshots');
fs.mkdirSync(uploadDir, { recursive: true });


const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});


/**
 * Calculate total due for a vendor as of a date.
 * Mirrors utils/dueCalculator.js functionality.
 */
async function calculateDueAtDate(targetDate, vendorName = null, excludePaymentId = null) {
  try {
    const date = new Date(targetDate);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);


    const invoiceMatch = {
      date: { $lte: endOfDay },
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };
    if (vendorName) invoiceMatch.partyName = vendorName;


    const totalInvoicesResult = await PurchaseRecord.aggregate([
      { $match: invoiceMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$invoiceAmount', 0] } } } },
    ]);
    const totalInvoices = totalInvoicesResult[0]?.total || 0;


    const paymentMatch = {
      date: { $lte: endOfDay },
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    };
    if (vendorName) paymentMatch.vendorName = vendorName;
    if (excludePaymentId) paymentMatch._id = { $ne: new mongoose.Types.ObjectId(excludePaymentId) };


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


// GET all payment records
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;


    const query = {
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } }
      ]
    };


    const [records, total] = await Promise.all([
      PaymentRecord.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      PaymentRecord.countDocuments(query)
    ]);


    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching payment records:', error);
    res.status(500).json({ error: 'Failed to fetch payment records' });
  }
});


// POST create new payment record (with optional screenshot file)
router.post('/', upload.single('screenshot'), async (req, res) => {
  try {
    const screenshotUrl = req.file
      ? `/uploads/payment-screenshots/${req.file.filename}`
      : (req.body.screenshot || '');


    const newRecord = new PaymentRecord({
      date: req.body.date || null,
      vendorName: req.body.vendorName || '',
      amountPaid: req.body.amountPaid || 0,
      amountDue: 0,
      dueAtThisDate: 0,
      screenshot: screenshotUrl,
      isDeleted: false
    });


    const saved = await newRecord.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error('Create error:', error);
    res.status(500).json({ error: 'Failed to create payment record' });
  }
});


// PATCH update record (allow replacing screenshot)
router.patch('/:id', upload.single('screenshot'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };


    if (req.file) {
      updates.screenshot = `/uploads/payment-screenshots/${req.file.filename}`;
    }


    // Get existing record
    const existingRecord = await PaymentRecord.findById(id);
    if (!existingRecord) {
      return res.status(404).json({ error: 'Payment record not found' });
    }


    // Build complete record state after updates
    const updatedState = {
      vendorName: updates.vendorName !== undefined ? updates.vendorName : existingRecord.vendorName,
      date: updates.date !== undefined ? updates.date : existingRecord.date,
      amountPaid: updates.amountPaid !== undefined ? updates.amountPaid : existingRecord.amountPaid
    };


    // Check if due is already locked permanently
    const isLocked = existingRecord.dueAtThisDate !== 0;
   
   


    if (isLocked) {
      // Due is already locked, don't touch it
      delete updates.dueAtThisDate;
      delete updates.amountDue;
     
    } else {
      // Not locked yet - check if this is the FINAL update (amountPaid being filled)
      const isFillingAmountPaid =
        updates.amountPaid !== undefined &&
        updates.amountPaid !== null &&
        updates.amountPaid !== '';


      if (isFillingAmountPaid) {
        // This is the FINAL step - user filled amountPaid
        // Check if we have all required fields
        const hasAllRequiredFields =
          updatedState.vendorName &&
          updatedState.vendorName.trim() !== '' &&
          updatedState.date;


        if (hasAllRequiredFields) {
          // STEP 1: Save the amountPaid FIRST
          const amountPaidValue = parseFloat(updates.amountPaid) || 0;
          await PaymentRecord.findByIdAndUpdate(
            id,
            { $set: { amountPaid: amountPaidValue } }
          );
       
         
          // STEP 2: NOW calculate due (will include the just-saved payment)
          const recordDate = new Date(updatedState.date);
          const calculatedDue = await calculateDueAtDate(recordDate, updatedState.vendorName);
         
          // STEP 3: LOCK the due permanently
          updates.dueAtThisDate = calculatedDue;
          updates.amountDue = calculatedDue;
          updates.amountPaid = amountPaidValue;
         
         
        } else {


         
          delete updates.amountDue;
          delete updates.dueAtThisDate;
        }
      } else {
        // User is just filling vendor/date - DON'T show amountDue yet
 
        delete updates.amountDue;
        delete updates.dueAtThisDate;
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
    res.status(500).json({ error: 'Failed to update payment record' });
  }
});


// DELETE payment record (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;


    const record = await PaymentRecord.findByIdAndUpdate(
      id,
      {
        isDeleted: true,
        deletedAt: new Date()
      },
      { new: true }
    );


    if (!record) {
      return res.status(404).json({ error: 'Payment record not found' });
    }


   
    res.json({ message: 'Payment record deleted', record });
  } catch (error) {
    console.error('Error deleting payment record:', error);
    res.status(500).json({ error: 'Failed to delete payment record' });
  }
});


// GET deleted payment records
router.get('/deleted', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;


    const query = { isDeleted: true };


    const [records, total] = await Promise.all([
      PaymentRecord.find(query)
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      PaymentRecord.countDocuments(query)
    ]);


    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching deleted payment records:', error);
    res.status(500).json({ error: 'Failed to fetch deleted payment records' });
  }
});


// PATCH restore deleted payment record
router.patch('/deleted/:id/restore', async (req, res) => {
  try {
    const record = await PaymentRecord.findByIdAndUpdate(
      req.params.id,
      {
        isDeleted: false,
        deletedAt: null
      },
      { new: true }
    );


    if (!record) {
      return res.status(404).json({ error: 'Payment record not found' });
    }




    res.json({ message: 'Payment record restored successfully', record });
  } catch (error) {
    console.error('Error restoring payment record:', error);
    res.status(500).json({ error: 'Failed to restore payment record' });
  }
});


module.exports = router;

