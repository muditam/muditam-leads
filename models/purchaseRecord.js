


const express = require('express');
const router = express.Router();
const PurchaseRecord = require('../models/purchaseRecord');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path'); 


// Configure Wasabi S3 Client
const s3Client = new S3Client({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY,
  },
});


// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);


    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images (JPEG, PNG) and PDF files are allowed!'));
    }
  },
});


// Upload file to Wasabi (helper)
async function uploadToWasabi(file) {
  const timestamp = Date.now();
  const fileName = `payment-screenshots/${timestamp}-${file.originalname}`;


  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: 'public-read',
  };


  try {
    await s3Client.send(new PutObjectCommand(params));
    const fileUrl = `${process.env.WASABI_ENDPOINT}/${process.env.WASABI_BUCKET}/${fileName}`;
    return fileUrl;
  } catch (error) {
    console.error('Error uploading to Wasabi:', error);
    throw error;
  }
}


// ========== LIST ACTIVE (NOT DELETED) RECORDS ==========
router.get('/purchase-records', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;


    // Treat false / null / missing as "not deleted"
    const query = {
      $or: [
        { isDeleted: false },
        { isDeleted: null },
        { isDeleted: { $exists: false } },
      ],
    };


    if (req.query.category) {
      query.category = req.query.category;
    }


    if (req.query.billingGst) {
      query.billingGst = req.query.billingGst;
    }


    if (req.query.paymentStatus) {
      query.paymentStatus = req.query.paymentStatus;
    }


    if (req.query.vendorSearch) {
      query.partyName = { $regex: req.query.vendorSearch, $options: 'i' };
    }


    const [records, total] = await Promise.all([
      PurchaseRecord.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      PurchaseRecord.countDocuments(query),
    ]);


    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching purchase records:', error);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});


// ========== LIST DELETED RECORDS ONLY ==========
router.get('/deleted-records', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const skip = (page - 1) * limit;


    // Only soft-deleted docs
    const query = { isDeleted: true };


    if (req.query.category) {
      query.category = req.query.category;
    }


    if (req.query.billingGst) {
      query.billingGst = req.query.billingGst;
    }


    if (req.query.paymentStatus) {
      query.paymentStatus = req.query.paymentStatus;
    }


    if (req.query.vendorSearch) {
      query.partyName = { $regex: req.query.vendorSearch, $options: 'i' };
    }


    const [records, total] = await Promise.all([
      PurchaseRecord.find(query)
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      PurchaseRecord.countDocuments(query),
    ]);


    res.json({
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching deleted records:', error);
    res.status(500).json({ error: 'Failed to fetch deleted records' });
  }
});


// ========== SOFT DELETE ==========
router.delete('/purchase-records/:id', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      {
        isDeleted: true,
        deletedAt: new Date(),
      },
      { new: true }
    );


    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }


   
    res.json({ message: 'Record moved to deleted records', record });
  } catch (error) {
    console.error('Error deleting record:', error);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});


// ========== RESTORE ==========
router.patch('/deleted-records/:id/restore', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      {
        isDeleted: false,
        deletedAt: null,
      },
      { new: true }
    );


    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }


   
    res.json({ message: 'Record restored successfully', record });
  } catch (error) {
    console.error('Error restoring record:', error);
    res.status(500).json({ error: 'Failed to restore record' });
  }
});


// ========== PERMANENT DELETE ==========
router.delete('/deleted-records/:id/permanent', async (req, res) => {
  try {
    const record = await PurchaseRecord.findByIdAndDelete(req.params.id);


    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }


 
    res.json({ message: 'Record permanently deleted' });
  } catch (error) {
    console.error('Error permanently deleting record:', error);
    res.status(500).json({ error: 'Failed to permanently delete record' });
  }
});


// ========== CREATE (with non-retroactive due calculation) ==========
router.post('/purchase-records', async (req, res) => {
  try {
   


    const recordData = {
      ...req.body,
      date: req.body.date || new Date(),
      dueAtThisDate: 0, // Initialize to 0, will calculate on first update
      updatedAt: new Date(),
      // isDeleted will default to false from schema
    };


    const record = new PurchaseRecord(recordData);
    await record.save();


    res.status(201).json(record);
  } catch (error) {
    console.error('Error creating purchase record:', error);
    res.status(400).json({ error: error.message });
  }
});


// ========== UPDATE (with non-retroactive due calculation) ==========
router.patch('/purchase-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    updates.updatedAt = new Date();


    // Get existing record
    const existingRecord = await PurchaseRecord.findById(id);


    if (!existingRecord) {
      return res.status(404).json({ error: 'Record not found' });
    }


    // Build complete record state after updates
    const updatedState = {
      partyName:
        updates.partyName !== undefined
          ? updates.partyName
          : existingRecord.partyName,
      date: updates.date !== undefined ? updates.date : existingRecord.date,
    };


   
    // Calculate when: NOT calculated yet AND both party name AND date are filled
    const shouldCalculateDue =
      existingRecord.dueAtThisDate === 0 &&
      updatedState.partyName &&
      updatedState.date;


    if (shouldCalculateDue) {
      const recordDate = new Date(updatedState.date);
      const dueAtThisDate = await calculateDueAtDate(recordDate);


      updates.dueAtThisDate = dueAtThisDate;


   
    } else {
   
      delete updates.dueAtThisDate;
    }


    const record = await PurchaseRecord.findByIdAndUpdate(id, updates, {
      new: true,
    });


 
    res.json(record);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ========== WASABI GENERIC UPLOAD ==========
router.post(
  '/uploadToWasabi',
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
   


      const fileKey = `purchase-records/${Date.now()}-${req.file.originalname}`;


      const uploadParams = {
        Bucket: process.env.WASABI_BUCKET,
        Key: fileKey,
        Body: req.file.buffer,
        ACL: 'public-read',
        ContentType: req.file.mimetype,
      };


      const command = new PutObjectCommand(uploadParams);
      await s3Client.send(command);


      const fileUrl = `https://${process.env.WASABI_BUCKET}.s3.${process.env.WASABI_REGION}.wasabisys.com/${fileKey}`;


      const recordId = req.body.recordId;
      const field = req.body.field || 'paymentScreenshot';


      if (recordId) {
        await PurchaseRecord.findByIdAndUpdate(recordId, {
          [field]: fileUrl,
          updatedAt: new Date(),
        });
       
      }


      res.json({ fileUrl, url: fileUrl });
    } catch (error) {
      console.error('Wasabi upload error:', error);
      res.status(500).json({
        error: 'Upload failed',
        details: error.message,
      });
    }
  }
);


// ========== SPECIFIC PAYMENT SCREENSHOT UPLOAD ==========
router.post(
  '/upload-payment-screenshot',
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }


      const fileUrl = await uploadToWasabi(req.file);


      if (req.body.recordId) {
        await PurchaseRecord.findByIdAndUpdate(req.body.recordId, {
          paymentScreenshot: fileUrl,
          updatedAt: new Date(),
        });
      }


      res.json({
        message: 'File uploaded successfully',
        fileUrl,
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      res.status(500).json({ error: error.message });
    }
  }
);


module.exports = router;



