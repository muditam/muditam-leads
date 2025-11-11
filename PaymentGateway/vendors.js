// PaymentGateway/vendors.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Vendor = require('../models/Vendor');
const PurchaseRecord = require('../models/PurchaseRecord');

// ---------------- Helpers ----------------
const isObjectId = (v) =>
  typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);

const trimOrEmpty = (v) => (typeof v === 'string' ? v.trim() : (v ?? ''));
const toLower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

const phoneRegex = /^\d{10}$/;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeGST = (gst) => String(gst || '').trim().toUpperCase();

// ---------------- Maintenance: fix legacy vendor IDs ----------------
router.post('/fix-vendor-ids', async (_req, res) => {
  try {
    const db = mongoose.connection.db;
    const vendorsCollection = db.collection('vendors');

    const allVendors = await vendorsCollection.find({}).toArray();

    let fixedCount = 0;
    let alreadyValidCount = 0;

    for (const vendor of allVendors) {
      const looksLikeValidObjectId =
        mongoose.Types.ObjectId.isValid(vendor._id) &&
        String(new mongoose.Types.ObjectId(vendor._id)) === String(vendor._id);

      if (!looksLikeValidObjectId) {
        // Delete legacy document with bad _id
        await vendorsCollection.deleteOne({ _id: vendor._id });

        // Re-insert with a fresh ObjectId (preserve fields)
        const newVendor = {
          name: vendor.name,
          phoneNumber: vendor.phoneNumber || vendor.phone || '',
          email: vendor.email || '',
          hasGST: !!vendor.hasGST,
          gstNumber: vendor.gstNumber || '',
          isDeleted: !!vendor.isDeleted,
          deletedAt: vendor.deletedAt || null,
          createdAt: vendor.createdAt || new Date(),
          updatedAt: new Date(),
        };

        await vendorsCollection.insertOne(newVendor);
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
    console.error('Error fixing vendor IDs:', error);
    res
      .status(500)
      .json({ error: 'Failed to fix vendor IDs', details: error.message });
  }
});

// ---------------- List vendors (active only) ----------------
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

    // Optional filters
    if (req.query.search) {
      const s = String(req.query.search).trim();
      if (s) {
        // Search by name or GST (exact), phone/email (contains)
        query.$or = [
          { name: { $regex: s, $options: 'i' } },
          { gstNumber: s.toUpperCase() },
          { phoneNumber: { $regex: s } },
          { email: { $regex: s, $options: 'i' } },
          ...query.$or, // keep "not deleted" condition
        ];
      }
    }

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
    console.error('Error fetching vendors:', error);
    res
      .status(500)
      .json({ error: 'Failed to fetch vendors', vendors: [], total: 0 });
  }
});

// ---------------- Get vendor by id ----------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Support legacy string _id docs as well
    if (isObjectId(id)) {
      const v = await Vendor.findById(id).lean();
      if (!v) return res.status(404).json({ error: 'Vendor not found' });
      return res.json(v);
    }

    const db = mongoose.connection.db;
    const doc = await db.collection('vendors').findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'Vendor not found' });
    return res.json(doc);
  } catch (error) {
    console.error('Error reading vendor:', error);
    res.status(500).json({ error: 'Failed to read vendor' });
  }
});

// ---------------- Create vendor ----------------
router.post('/', async (req, res) => {
  try {
    const name = trimOrEmpty(req.body.name);
    const phoneNumber = trimOrEmpty(req.body.phoneNumber);
    const email = toLower(req.body.email);
    const hasGST = !!req.body.hasGST;
    const gst = normalizeGST(req.body.gstNumber);

    if (!name) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }

    if (phoneNumber && !phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
    }

    if (email && !emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    // GST validation + uniqueness (soft active vendors)
    let gstToSave = '';
    if (hasGST) {
      if (!gst) {
        return res.status(400).json({ error: 'GST number is required when GST is enabled.' });
      }
      if (gst.length !== 15) {
        return res.status(400).json({ error: 'GST number must be exactly 15 characters.' });
      }

      const existingGST = await Vendor.findOne({
        gstNumber: gst,
        $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
      }).lean();

      if (existingGST) {
        return res.status(400).json({
          error: 'GST number already exists',
          message: `GST ${gst} is already registered with vendor: ${existingGST.name}`,
          existingVendor: existingGST.name,
        });
      }
      gstToSave = gst;
    }

    // Name uniqueness among active vendors (case-insensitive)
    const existingByName = await Vendor.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    }).lean();

    if (existingByName) {
      return res.status(400).json({ error: 'Vendor already exists' });
    }

    const vendor = new Vendor({
      name,
      phoneNumber,
      email,
      hasGST,
      gstNumber: gstToSave,
    });

    const savedVendor = await vendor.save();
    res.status(201).json(savedVendor);
  } catch (error) {
    console.error('Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to create vendor' });
  }
});

// ---------------- Update vendor (supports ObjectId + legacy string _id) ----------------
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    // Normalize inputs if present
    if (typeof updates.name !== 'undefined' && updates.name !== null) {
      updates.name = trimOrEmpty(updates.name);
    }

    if (typeof updates.phoneNumber !== 'undefined' && updates.phoneNumber !== null) {
      const phone = trimOrEmpty(updates.phoneNumber);
      if (phone && !phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
      }
      updates.phoneNumber = phone;
    }

    if (typeof updates.email !== 'undefined' && updates.email !== null) {
      const email = toLower(updates.email);
      if (email && !emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format.' });
      }
      updates.email = email;
    }

    if (typeof updates.hasGST !== 'undefined' || typeof updates.gstNumber !== 'undefined') {
      const hasGSTFlag = typeof updates.hasGST !== 'undefined' ? !!updates.hasGST : undefined;

      if (hasGSTFlag === true) {
        const gst = normalizeGST(updates.gstNumber);
        if (!gst) {
          return res.status(400).json({ error: 'GST number is required when GST is enabled.' });
        }
        if (gst.length !== 15) {
          return res.status(400).json({ error: 'GST number must be exactly 15 characters.' });
        }

        // Ensure GST uniqueness excluding this record (supports ObjectId or legacy id)
        const neFilter = isObjectId(id) ? { _id: { $ne: new mongoose.Types.ObjectId(id) } } : { _id: { $ne: id } };

        const existingGSTVendor = await Vendor.findOne({
          gstNumber: gst,
          ...neFilter,
          $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
        }).lean();

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

    // Apply update
    if (isObjectId(id)) {
      const vendor = await Vendor.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
      if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
      return res.json(vendor);
    }

    // Legacy _id string document
    const db = mongoose.connection.db;
    const collection = db.collection('vendors');

    const result = await collection.updateOne({ _id: id }, { $set: updates });
    if (!result.matchedCount) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    const updated = await collection.findOne({ _id: id });
    return res.json(updated);
  } catch (error) {
    console.error('Error updating vendor:', error);
    res.status(500).json({ error: 'Failed to update vendor', details: error.message });
  }
});

// ---------------- Soft delete vendor ----------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjectId(id)) {
      return res.status(400).json({ error: 'Invalid vendor ID format' });
    }

    const vendor = await Vendor.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json({ message: 'Vendor deleted', vendor });
  } catch (error) {
    console.error('Error deleting vendor:', error);
    res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

// ---------------- Sync vendors from purchase records ----------------
router.post('/sync-from-purchases', async (_req, res) => {
  try {
    const purchaseRecords = await PurchaseRecord.find({
      partyName: { $ne: '', $exists: true },
      $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
    })
      .select('partyName')
      .lean();

    const uniquePartyNames = [
      ...new Set(
        purchaseRecords
          .map((r) => trimOrEmpty(r.partyName))
          .filter((name) => name)
      ),
    ];

    let syncedCount = 0;
    let skippedCount = 0;
    const errors = [];

    for (const partyName of uniquePartyNames) {
      try {
        const exists = await Vendor.findOne({
          name: { $regex: new RegExp(`^${partyName}$`, 'i') },
          $or: [{ isDeleted: false }, { isDeleted: null }, { isDeleted: { $exists: false } }],
        }).lean();

        if (!exists) {
          await Vendor.create({
            name: partyName,
            phoneNumber: '',
            email: '',
            hasGST: false,
            gstNumber: '',
          });
          syncedCount++;
        } else {
          skippedCount++;
        }
      } catch (e) {
        console.error(`Error syncing vendor "${partyName}":`, e.message);
        errors.push({ vendor: partyName, error: e.message });
      }
    }

    res.json({
      message: 'Vendors synced successfully',
      syncedCount,
      skippedCount,
      total: uniquePartyNames.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (error) {
    console.error('Sync vendors error:', error);
    res.status(500).json({ error: 'Failed to sync vendors', details: error.message });
  }
});

module.exports = router;
