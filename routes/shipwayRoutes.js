const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

// POST /api/shipway/update-status
router.post('/update-status', async (req, res) => {
  const { orderId, newStatus, selfUpdated } = req.body;

  if (!orderId || typeof newStatus !== 'string') {
    return res.status(400).json({ message: 'Invalid request parameters' });
  }

  try {
    // Normalize only if your DB does NOT store the #
    const normalizedId = orderId.replace(/^#/, '');

    const updatedOrder = await Order.findOneAndUpdate(
      { order_id: normalizedId }, // OR use orderId directly if DB includes '#'
      {
        $set: {
          shipment_status: newStatus,
          last_updated_at: new Date(),
          selfUpdated: !!selfUpdated, // mark customer update
        },
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.status(200).json({ message: 'Status updated successfully', order: updatedOrder });
  } catch (err) {
    console.error('Error updating shipment status:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
