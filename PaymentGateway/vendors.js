// routes/vendors.js
const express = require('express');
const router = express.Router();
const Vendor = require('../models/Vendor');
const PurchaseRecord = require('../models/PurchaseRecord');
const mongoose = require('mongoose');


// POST - Fix existing vendors with invalid IDs (migration)
router.post('/fix-vendor-ids', async (req, res) => {
  try {
   


    const db = mongoose.connection.db;
    const vendorsCollection = db.collection('vendors');


    const allVendors = await vendorsCollection.find({}).toArray();


    let fixedCount = 0;
    let alreadyValidCount = 0;


    for (const vendor of allVendors) {
      const isValidObjectId =
        mongoose.Types.ObjectId.isValid(vendor._id) &&
        String(new mongoose.Types.ObjectId(vendor._id)) === String(vendor._id);


      if (!isValidObjectId) {


        await vendorsCollection.deleteOne({ _id: vendor._id });


        const newVendor = {
          name: vendor.name,
          phoneNumber: vendor.phoneNumber || vendor.phone || '',
          email: vendor.email || '',
          hasGST: vendor.hasGST || false,
          gstNumber: vendor.gstNumber || '',
          isDeleted: vendor.isDeleted || false,
          deletedAt: vendor.deletedAt || null,
          createdAt: vendor.createdAt || new Date(),
          updatedAt: new Date(),
        };


        const result = await vendorsCollection.insertOne(newVendor);
        fixedCount++;
       
      } else {
        alreadyValidCount++;
      }
    }




    res.json({
      message: 'Vendor IDs fixed successfully',
      fixedCount,
      alreadyValidCount,
      total: allVendors.length,
    });
  } catch (error) {
    console.error('❌ Error fixing vendor IDs:', error);
    res
      .status(500)
      .json({ error: 'Failed to fix vendor IDs', details: error.message });
  }
});


// GET all vendors
router.get('/', async (req, res) => {
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


    const [vendors, total] = await Promise.all([
      Vendor.find(query).sort({ name: 1 }).skip(skip).limit(limit).lean().exec(),
      Vendor.countDocuments(query),
    ]);




    res.json({
      vendors,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('❌ Error fetching vendors:', error);
    res
      .status(500)
      .json({ error: 'Failed to fetch vendors', vendors: [], total: 0 });
  }
});


// POST - Create new vendor (GST unique)
router.post('/', async (req, res) => {
  try {
    const { name, phoneNumber, email, hasGST, gstNumber } = req.body;


    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }


    if (phoneNumber) {
      const phone = String(phoneNumber).trim();
      if (phone && !/^\d{10}$/.test(phone)) {
        return res
          .status(400)
          .json({ error: 'Phone number must be exactly 10 digits.' });
      }
    }


    // 📧 Email validation (optional but must be valid if provided)
    if (email) {
      const emailTrim = String(email).trim();
      if (emailTrim && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
        return res.status(400).json({ error: 'Invalid email format.' });
      }
    }


    // 🧾 GST validation + uniqueness
    let normalizedGST = '';
    if (hasGST) {
      normalizedGST = (gstNumber || '').toString().trim().toUpperCase();
      if (!normalizedGST) {
        return res
          .status(400)
          .json({ error: 'GST number is required when GST is enabled.' });
      }
      if (normalizedGST.length !== 15) {
        return res
          .status(400)
          .json({ error: 'GST number must be exactly 15 characters.' });
      }


      const existingGSTVendor = await Vendor.findOne({
        gstNumber: normalizedGST,
        $or: [
          { isDeleted: false },
          { isDeleted: null },
          { isDeleted: { $exists: false } },
        ],
      });


      if (existingGSTVendor) {
        return res.status(400).json({
          error: 'GST number already exists',
          message: `GST ${normalizedGST} is already registered with vendor: ${existingGSTVendor.name}`,
          existingVendor: existingGSTVendor.name,
        });
      }
    }


    // 🔁 Check if vendor with same name already exists (active)
    const existingVendorByName = await Vendor.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    });


    if (existingVendorByName) {
      return res.status(400).json({ error: 'Vendor already exists' });
    }


    const vendor = new Vendor({
      name: name.trim(),
      phoneNumber: phoneNumber ? String(phoneNumber).trim() : '',
      email: email ? String(email).trim().toLowerCase() : '',
      hasGST: !!hasGST,
      gstNumber: normalizedGST,
    });


    const savedVendor = await vendor.save();


    res.status(201).json(savedVendor);
  } catch (error) {
    console.error('❌ Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});


// PATCH - Update vendor (supports ObjectId + legacy string _id, GST unique)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };




    // ---- PHONE VALIDATION ----
    if (typeof updates.phoneNumber !== 'undefined' && updates.phoneNumber !== null) {
      const phone = String(updates.phoneNumber).trim();
      if (phone && !/^\d{10}$/.test(phone)) {
        return res
          .status(400)
          .json({ error: 'Phone number must be exactly 10 digits.' });
      }
      updates.phoneNumber = phone;
    }


    // ---- EMAIL VALIDATION ----
    if (typeof updates.email !== 'undefined' && updates.email !== null) {
      const email = String(updates.email).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format.' });
      }
      updates.email = email.toLowerCase();
    }




    if (
      typeof updates.hasGST !== 'undefined' ||
      typeof updates.gstNumber !== 'undefined'
    ) {
      const hasGSTFlag =
        typeof updates.hasGST !== 'undefined' ? !!updates.hasGST : undefined;
      let gst = '';


      if (hasGSTFlag) {
        gst = (updates.gstNumber || '').toString().trim().toUpperCase();
        if (!gst) {
          return res
            .status(400)
            .json({ error: 'GST number is required when GST is enabled.' });
        }
        if (gst.length !== 15) {
          return res
            .status(400)
            .json({ error: 'GST number must be exactly 15 characters.' });
        }


        const existingGSTVendor = await Vendor.findOne({
          gstNumber: gst,
          _id: { $ne: id },
          $or: [
            { isDeleted: false },
            { isDeleted: null },
            { isDeleted: { $exists: false } },
          ],
        });


        if (existingGSTVendor) {
          return res.status(400).json({
            error: 'GST number already exists',
            message: `GST ${gst} is already registered with vendor: ${existingGSTVendor.name}`,
            existingVendor: existingGSTVendor.name,
          });
        }


        updates.gstNumber = gst;
        updates.hasGST = true;
      } else if (hasGSTFlag === false) {
     
        updates.hasGST = false;
        updates.gstNumber = '';
      }
    }


    const isValidObjectId =
      mongoose.Types.ObjectId.isValid(id) &&
      String(new mongoose.Types.ObjectId(id)) === String(id);


    const db = mongoose.connection.db;
    const collection = db.collection('vendors');




    if (isValidObjectId) {
      const vendor = await Vendor.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );


      if (!vendor) {
        return res.status(404).json({ error: 'Vendor not found' });
      }


      return res.json(vendor);
    }




    const updateResult = await collection.updateOne({ _id: id }, { $set: updates });


    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: 'Vendor not found' });
    }


    const updatedVendor = await collection.findOne({ _id: id });


    return res.json(updatedVendor);
  } catch (error) {
    console.error('❌ Error updating vendor:', error);
    res
      .status(500)
      .json({ error: 'Failed to update vendor', details: error.message });
  }
});




router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;


    const isValidObjectId =
      mongoose.Types.ObjectId.isValid(id) &&
      String(new mongoose.Types.ObjectId(id)) === String(id);


    if (!isValidObjectId) {
      return res.status(400).json({ error: 'Invalid vendor ID format' });
    }


    const vendor = await Vendor.findByIdAndUpdate(
      id,
      {
        isDeleted: true,
        deletedAt: new Date(),
      },
      { new: true }
    );


    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }


    res.json({ message: 'Vendor deleted', vendor });
  } catch (error) {
    console.error('❌ Error deleting vendor:', error);
    res.status(500).json({ error: 'Failed to delete vendor' });
  }
});


// POST - Sync vendors from purchase records
router.post('/sync-from-purchases', async (req, res) => {
  try {


    const purchaseRecords = await PurchaseRecord.find({
      partyName: { $ne: '', $exists: true },
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    })
      .select('partyName')
      .lean();




    const uniquePartyNames = [
      ...new Set(
        purchaseRecords
          .map((record) => record.partyName)
          .filter((name) => name && name.trim() !== '')
      ),
    ];




    let syncedCount = 0;
    let skippedCount = 0;
    let errors = [];


    for (const partyName of uniquePartyNames) {
      try {
        const existingVendor = await Vendor.findOne({
          name: { $regex: new RegExp(`^${partyName.trim()}$`, 'i') },
          $or: [
            { isDeleted: false },
            { isDeleted: null },
            { isDeleted: { $exists: false } },
          ],
        });


        if (!existingVendor) {
          const newVendor = await Vendor.create({
            name: partyName.trim(),
            phoneNumber: '',
            email: '',
            hasGST: false,
            gstNumber: '',
          });
          syncedCount++;
         
        } else {
          skippedCount++;
        }
      } catch (error) {
        console.error(
          `   ❌ Error syncing vendor "${partyName}":`,
          error.message
        );
        errors.push({ vendor: partyName, error: error.message });
      }
    }


   
    if (errors.length > 0) {
     
    }


    res.json({
      message: 'Vendors synced successfully',
      syncedCount,
      skippedCount,
      total: uniquePartyNames.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
 
    res
      .status(500)
      .json({ error: 'Failed to sync vendors', details: error.message });
  }
});


module.exports = router;



