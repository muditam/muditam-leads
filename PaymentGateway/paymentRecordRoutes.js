

const express = require('express');
const router = express.Router();
const PaymentRecord = require('../models/PaymentRecord');


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


// POST create new payment record
router.post('/', async (req, res) => {
  try {
    const newRecord = new PaymentRecord({
      date: req.body.date || null,
      vendorName: req.body.vendorName || '',
      amountPaid: req.body.amountPaid || 0,
      amountDue: 0,
      dueAtThisDate: 0,
      screenshot: req.body.screenshot || '',
      isDeleted: false
    });


    const saved = await newRecord.save();


   
    res.status(201).json(saved);
  } catch (error) {


    res.status(500).json({ error: 'Failed to create payment record' });
  }
});


// PATCH - Update payment record
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
   
   
   
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

