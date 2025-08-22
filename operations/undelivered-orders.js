const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

// routes/orders.js  (only the GET /api/orders/undelivered route shown)

router.get('/undelivered', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const priorityFilter = (req.query.priority || '').trim();

    const now = new Date();

    const preStages = [
      { $match: { shipment_status: { $nin: ['Delivered', 'RTO Delivered'] } } },
      { $addFields: { _len: { $strLenCP: '$order_id' }, _first: { $substrCP: ['$order_id', 0, 1] } } },
      { $addFields: {
          normalizedOrderId: {
            $cond: [
              { $eq: ['$_first', '#'] },
              { $substrCP: ['$order_id', 1, { $subtract: ['$_len', 1] }] },
              '$order_id'
            ]
          }
      }},
      { $addFields: { displayOrderId: { $concat: ['#', '$normalizedOrderId'] } } },
      { $addFields: {
          ageDays: {
            $floor: {
              $divide: [
                { $subtract: [now, { $ifNull: ['$order_date', now] }] },
                1000 * 60 * 60 * 24
              ]
            }
          }
      }},
      { $addFields: {
          priority: {
            $switch: {
              branches: [
                { case: { $lte: ['$ageDays', 3] }, then: 'Low' },
                { case: { $and: [{ $gte: ['$ageDays', 4] }, { $lte: ['$ageDays', 7] }] }, then: 'Medium' }
              ],
              default: 'High'
            }
          }
      }}
    ];

    const countsPipeline = [
      ...preStages,
      { $group: { _id: '$priority', count: { $sum: 1 } } }
    ];

    const dataPipeline = [
      ...preStages,
      ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),
      { $addFields: {
          priorityWeight: {
            $switch: {
              branches: [
                { case: { $eq: ['$priority', 'High'] }, then: 1 },
                { case: { $eq: ['$priority', 'Medium'] }, then: 2 }
              ],
              default: 3
            }
          }
      }},
      { $sort: { priorityWeight: 1, ageDays: -1, last_updated_at: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      // PROJECT EXACT FIELDS THE UI BINDS TO
      {
        $project: {
          _id: 1,
          order_id: '$normalizedOrderId',       // ← Order ID without '#'
          shipment_status: 1,          // ← Status
          order_date: 1,               // ← Order Date
          tracking_number: 1,          // ← Tracking No.
          carrier_title: 1             // ← Carrier
        }
      }
    ];

    const totalPipeline = [
      ...preStages,
      ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),
      { $count: 'total' }
    ];

    const [countsAgg, dataAgg, totalAgg] = await Promise.all([
      Order.aggregate(countsPipeline).allowDiskUse(true),
      Order.aggregate(dataPipeline).allowDiskUse(true),
      Order.aggregate(totalPipeline).allowDiskUse(true)
    ]);

    const counts = { High: 0, Medium: 0, Low: 0 };
    (countsAgg || []).forEach(c => { counts[c._id] = c.count; });

    res.json({
      page,
      limit,
      total: totalAgg?.[0]?.total || 0,
      counts,
      data: dataAgg || []
    });
  } catch (err) {
    console.error('GET /api/orders/undelivered error:', err);
    res.status(500).json({ error: 'Failed to fetch undelivered orders.' });
  }
});


module.exports = router;
