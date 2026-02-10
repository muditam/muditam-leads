const express = require('express');
const router = express.Router();
const Order = require('../models/Order');


const EXCLUDED_STATUSES = ['Delivered', 'RTO Delivered'];


router.get('/undelivered-orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;
    const carrierFilter = req.query.carrier;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;


    const filter = {
      shipment_status: { $nin: EXCLUDED_STATUSES },
    };


    if (statusFilter && !EXCLUDED_STATUSES.includes(statusFilter)) {
      filter.shipment_status = statusFilter;
    }


    if (carrierFilter) {
      filter.carrier_title = carrierFilter;
    }


    if (startDate || endDate) {
      filter.order_date = {};
      if (startDate) {
        filter.order_date.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.order_date.$lte = new Date(endDate);
      }
    }


    const orders = await Order.find(filter)
      .sort({ order_date: -1 })
      .skip(skip)
      .limit(limit);


    const totalCount = await Order.countDocuments(filter);


    const statusCounts = await Order.aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$shipment_status",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          shipment_status: "$_id",
          count: 1,
          _id: 0
        }
      }
    ]);


    const carrierList = await Order.distinct("carrier_title");


    res.json({
      orders,
      totalCount,
      statusCounts,
      carriers: carrierList.filter(Boolean),
    });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


module.exports = router;



