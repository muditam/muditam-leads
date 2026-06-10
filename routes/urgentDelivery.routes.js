const express = require('express');
const router = express.Router();
const UrgentDelivery = require('../models/UrgentDelivery');

router.get('/', async (req, res) => {
  try {
    const status = req.query.status === 'Delivered' ? 'Delivered' : 'Pending';
    const data = await UrgentDelivery.find({ status })
      .sort(status === 'Delivered' ? { deliveredAt: -1 } : { createdAt: -1 })
      .lean();

    res.json({ data });
  } catch (err) {
    console.error('Failed to fetch urgent deliveries:', err);
    res.status(500).json({ error: 'Failed to fetch urgent deliveries' });
  }
});

router.post('/', async (req, res) => {
  try {
    const date = String(req.body.date || '').trim();
    const orderId = String(req.body.orderId || '').trim();

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    const urgentDelivery = new UrgentDelivery({
      date,
      orderId,
      name: req.body.name || '',
      contactNumber: req.body.contactNumber || '',
      expertName: req.body.expertName || '',
      remark: req.body.remark || '',
    });

    const saved = await urgentDelivery.save();
    res.json(saved);
  } catch (err) {
    console.error('Failed to save urgent delivery:', err);
    res.status(500).json({ error: 'Failed to save urgent delivery' });
  }
});

router.patch('/:id/delivered', async (req, res) => {
  try {
    const updated = await UrgentDelivery.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'Delivered', deliveredAt: new Date() } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Urgent delivery not found' });
    }

    res.json(updated);
  } catch (err) {
    console.error('Failed to mark urgent delivery delivered:', err);
    res.status(500).json({ error: 'Failed to mark urgent delivery delivered' });
  }
});

module.exports = router;
