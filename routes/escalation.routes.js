const express = require('express');
const router = express.Router();
const multer = require('multer');
const AWS = require('aws-sdk');
const Escalation = require('../models/escalation.model');
const Order = require('../models/Order');

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

router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,            // e.g. "Open,In Progress" or "Closed"
      assignedTo,
      search,            // matches orderId/name/contactNumber
      sortBy = 'createdAt',
      order = 'desc',
    } = req.query; 

    const filter = {};
    if (status) {
      filter.status = { $in: status.split(',').map(s => s.trim()) };
    }
    if (assignedTo) {
      filter.assignedTo = assignedTo;
    }
    if (search && String(search).trim()) {
      const s = String(search).trim();
      filter.$or = [
        { orderId:       new RegExp(s, 'i') },
        { name:          new RegExp(s, 'i') },
        { contactNumber: new RegExp(s, 'i') },
      ];
    }

    const sort = { [sortBy]: order === 'asc' ? 1 : -1 };
    const pageNum = Math.max(1, Number(page));
    const perPage = Math.min(200, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * perPage;

    const [data, total] = await Promise.all([
      Escalation.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(perPage)
        .select('date orderId name contactNumber agentName query attachedFileUrls status assignedTo remark resolvedDate reason createdAt trackingId')
        .lean(),  // much faster, smaller payloads
      Escalation.countDocuments(filter),
    ]);

    res.json({ data, total, page: pageNum, limit: perPage });
  } catch (err) { 
    console.error('Failed to fetch escalations:', err);
    res.status(500).json({ error: 'Failed to fetch escalations' });
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

    const rawOrder = String(req.body.orderId || '').trim();

    if (/#/i.test(rawOrder) || /^\s*#\s*ma/i.test(rawOrder)) {
     return res.status(400).json({ error: 'Add order id without #MA' });
    }

    const digits = rawOrder.replace(/\D/g, '');
    if (!digits) {
      return res.status(400).json({ error: 'Invalid order id' });
    }
    const normalizedOrderId = `MA${digits}`;
 
    const orderDoc = await Order.findOne({
      order_id: { $in: [normalizedOrderId, `#${normalizedOrderId}`] }
    }).select('tracking_number').lean();

    const trackingId = orderDoc?.tracking_number || '';


    const escalation = new Escalation({
      date: req.body.date,
      orderId: normalizedOrderId,
      name: req.body.name,
      contactNumber: req.body.contactNumber,
      agentName: req.body.agentName,
      query: req.body.query,
      attachedFileUrls: fileUrls,  
      status: req.body.status || 'Open',
      assignedTo: req.body.assignedTo || '',
      remark: req.body.remark || '', 
      resolvedDate: req.body.resolvedDate || '',
      reason: req.body.reason || '',
      trackingId,
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
