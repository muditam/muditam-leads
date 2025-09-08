// routes/orders.js
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

router.get('/undelivered', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const priorityFilter = (req.query.priority || '').trim();

    const startDateStr = (req.query.startDate || '').trim();
    const endDateStr   = (req.query.endDate   || '').trim();
    const statusCSV    = (req.query.status    || '').trim();

    let dateMatch = null;
    if (startDateStr || endDateStr) {
      const start = new Date(`${startDateStr || endDateStr}T00:00:00.000Z`);
      const end   = new Date(`${endDateStr || startDateStr}T23:59:59.999Z`); 
      dateMatch = { order_date: { $gte: start, $lte: end } };
    }

    let statusMatch = null;
    if (statusCSV) {
      const statuses = statusCSV.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) statusMatch = { shipment_status: { $in: statuses } };
    }

    const now = new Date(); 

    const preStages = [
      { $match: { shipment_status: { $nin: ['Delivered', 'RTO Delivered', 'Shipment Booked', 'Status Pending'] } } },
      ...(dateMatch ? [{ $match: dateMatch }] : []),
      ...(statusMatch ? [{ $match: statusMatch }] : []),
 
      {
        $addFields: {
          ageDays: {
            $floor: {
              $divide: [{ $subtract: [now, { $ifNull: ['$order_date', now] }] }, 1000 * 60 * 60 * 24]
            }
          }
        }
      },
      {
        $addFields: {
          priority: {
            $switch: {
              branches: [
                { case: { $lte: ['$ageDays', 3] }, then: 'Low' },
                { case: { $and: [{ $gte: ['$ageDays', 4] }, { $lte: ['$ageDays', 7] }] }, then: 'Medium' },
              ],
              default: 'High'
            }
          }
        }
      }
    ];

    // Facets / counts (unchanged)
    const statusesPipeline = [
      ...preStages,
      { $group: { _id: '$shipment_status' } },
      { $sort: { _id: 1 } }
    ];
    const countsPipeline = [
      ...preStages,
      { $group: { _id: '$priority', count: { $sum: 1 } } }
    ];

    // Data: add lookup to escalations and return hasEscalation
    const dataPipeline = [
      ...preStages,
      ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),

      // --- lookup escalations by normalized order id (strip '#' and uppercase on BOTH sides) ---
      {
        $lookup: {
          from: 'escalations',
          let: {
            oid: {
              $toUpper: {
                $cond: [
                  { $eq: [{ $substrCP: ['$order_id', 0, 1] }, '#'] },
                  { $substrCP: ['$order_id', 1, { $subtract: [{ $strLenCP: '$order_id' }, 1] }] },
                  '$order_id'
                ]
              }
            }
          },
          pipeline: [
            {
              $addFields: {
                eIdNorm: {
                  $toUpper: {
                    $cond: [
                      { $eq: [{ $substrCP: ['$orderId', 0, 1] }, '#'] },
                      { $substrCP: ['$orderId', 1, { $subtract: [{ $strLenCP: '$orderId' }, 1] }] },
                      '$orderId'
                    ]
                  }
                }
              }
            },
            { $match: { $expr: { $eq: ['$eIdNorm', '$$oid'] } } },
            { $limit: 1 }
          ],
          as: 'esc'
        }
      },
      { $addFields: { hasEscalation: { $gt: [{ $size: '$esc' }, 0] } } },

      // sort + paginate
      {
        $addFields: {
          priorityWeight: {
            $switch: {
              branches: [
                { case: { $eq: ['$priority', 'High'] }, then: 1 },
                { case: { $eq: ['$priority', 'Medium'] }, then: 2 },
              ],
              default: 3
            }
          }
        }
      },
      { $sort: { priorityWeight: 1, order_date: -1, last_updated_at: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },

      // Project fields the UI uses (include contact_number + hasEscalation)
      {
        $project: {
          _id: 1,
          order_id: 1,
          contact_number: 1,
          shipment_status: 1,
          order_date: 1,
          tracking_number: 1,
          carrier_title: 1,
          priority: 1,
          hasEscalation: 1
        }
      }
    ];

    const totalPipeline = [
      ...preStages,
      ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),
      { $count: 'total' }
    ];

    const [countsAgg, dataAgg, totalAgg, statusesAgg] = await Promise.all([
      Order.aggregate(countsPipeline).allowDiskUse(true),
      Order.aggregate(dataPipeline).allowDiskUse(true),
      Order.aggregate(totalPipeline).allowDiskUse(true),
      Order.aggregate(statusesPipeline).allowDiskUse(true),
    ]);

    const counts = { High: 0, Medium: 0, Low: 0 };
    (countsAgg || []).forEach(c => { counts[c._id] = c.count; });

    res.json({
      page,
      limit,
      total: totalAgg?.[0]?.total || 0,
      counts,
      data: dataAgg || [],
      facets: {
        statuses: (statusesAgg || []).map(s => s._id).filter(Boolean)
      }
    });
  } catch (err) {
    console.error('GET /api/orders/undelivered error:', err);
    res.status(500).json({ error: 'Failed to fetch undelivered orders.' });
  }
});

module.exports = router;
