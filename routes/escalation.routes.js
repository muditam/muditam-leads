const express = require('express');
const router = express.Router();
const multer = require('multer');
const AWS = require('aws-sdk');
const Escalation = require('../models/escalation.model');

// Configure AWS S3 (Wasabi)
const s3 = new AWS.S3({
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
});

// Multer setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Get all escalations
router.get('/', async (req, res) => {
  try {
    const escalations = await Escalation.find();
    res.json(escalations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add escalation with optional file upload
router.post('/', upload.array('attachedFiles'), async (req, res) => {
  try {
    const fileUrls = [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const params = {
          Bucket: process.env.WASABI_BUCKET,
          Key: `escalations/${Date.now()}_${file.originalname}`,
          Body: file.buffer,
          ContentType: file.mimetype,
          ACL: 'public-read',
        };
        const data = await s3.upload(params).promise();
        fileUrls.push(data.Location);
      }
    }

    const escalation = new Escalation({
      date: req.body.date,
      orderId: req.body.orderId,
      name: req.body.name,
      contactNumber: req.body.contactNumber,
      agentName: req.body.agentName,
      query: req.body.query,
      attachedFileUrls: fileUrls, // plural array here
      status: req.body.status || 'Open',
      assignedTo: req.body.assignedTo || '',
      remark: req.body.remark || '',
      resolvedDate: req.body.resolvedDate || '',
    });

    const saved = await escalation.save();
    res.json(saved);
  } catch (err) {
    console.error('Error saving escalation:', err);
    res.status(500).json({ error: 'Failed to save escalation' });
  }
});

// Update escalation (editable fields only)
router.put('/:id', async (req, res) => {
  try {
    const updateFields = {};

    if (req.body.status !== undefined) updateFields.status = req.body.status;
    if (req.body.assignedTo !== undefined) updateFields.assignedTo = req.body.assignedTo;
    if (req.body.remark !== undefined) updateFields.remark = req.body.remark;
    if (req.body.resolvedDate !== undefined) updateFields.resolvedDate = req.body.resolvedDate;

    const updated = await Escalation.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    );
 
    if (!updated) {
      return res.status(404).json({ error: 'Escalation not found' });
    }

    res.json(updated);
  } catch (err) {
    console.error('Failed to update escalation:', err);
    res.status(500).json({ error: 'Failed to update escalation' });
  }
});


// Delete escalation by ID
router.delete('/:id', async (req, res) => {
    try {
      const deleted = await Escalation.findByIdAndDelete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Escalation not found' });
      }
      res.json({ message: 'Escalation deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete escalation' });
    }
  });
  

module.exports = router;
