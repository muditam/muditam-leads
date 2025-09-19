// routes/orders.js
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

// NOTE: For best performance, create these indexes (run once in your setup):
// db.orders.createIndex({ shipment_status: 1, order_date: -1, last_updated_at: -1 })
// db.orders.createIndex({ order_id: 1 })
// db.escalations.createIndex({ orderId: 1 })
// db.shopifyorders.createIndex({ orderName: 1 })
// db.myorders.createIndex({ orderId: 1 })   // <— NEW: needed for agentName lookup

router.get('/undelivered', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const priorityFilter = (req.query.priority || '').trim();

    const startDateStr = (req.query.startDate || '').trim();
    const endDateStr = (req.query.endDate || '').trim();
    const statusCSV = (req.query.status || '').trim();

    // Optional date window
    let dateMatch = null;
    if (startDateStr || endDateStr) {
      const start = new Date(`${startDateStr || endDateStr}T00:00:00.000Z`);
      const end = new Date(`${endDateStr || startDateStr}T23:59:59.999Z`);
      dateMatch = { order_date: { $gte: start, $lte: end } };
    }

    // Optional status filter
    let statusMatch = null;
    if (statusCSV) {
      const statuses = statusCSV.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length) statusMatch = { shipment_status: { $in: statuses } };
    }

    const now = new Date();

    // Base stages shared by all facets. Keep this cheap so it can use indexes.
    const base = [
      { $match: { shipment_status: { $nin: ['Delivered', 'RTO Delivered', 'Shipment Booked', 'Status Pending'] } } },
      ...(dateMatch ? [{ $match: dateMatch }] : []),
      ...(statusMatch ? [{ $match: statusMatch }] : []),

      // Compute age & priority
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

    const pipeline = [
      ...base,
      {
        $facet: {
          // ===== ROWS (paged) =====
          rows: [
            ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),

            // Deterministic sort first so skip/limit shrink dataset BEFORE lookups.
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
            { $sort: { priorityWeight: 1, order_date: -1, last_updated_at: -1, _id: 1 } },

            // Early projection to keep documents small
            {
              $project: {
                _id: 1,
                order_id: 1,
                contact_number: 1,
                full_name: 1,
                shipment_status: 1,
                order_date: 1,
                tracking_number: 1,
                carrier_title: 1,
                priority: 1,
                issue: 1
              }
            },

            // Page window BEFORE lookups (big win)
            { $skip: (page - 1) * limit },
            { $limit: limit },

            // Build two order_id variants: with '#' and without '#'
            {
              $addFields: {
                oWithHash: {
                  $cond: [
                    { $eq: [{ $substrCP: ['$order_id', 0, 1] }, '#'] },
                    '$order_id',
                    { $concat: ['#', { $ifNull: ['$order_id', ''] }] }
                  ]
                },
                oWithoutHash: {
                  $cond: [
                    { $eq: [{ $substrCP: ['$order_id', 0, 1] }, '#'] },
                    { $substrCP: ['$order_id', 1, { $subtract: [{ $strLenCP: '$order_id' }, 1] }] },
                    { $ifNull: ['$order_id', ''] }
                  ]
                }
              }
            },

            {
              $lookup: {
                from: 'myorders',
                let: { a: '$oWithHash', b: '$oWithoutHash' },
                pipeline: [
                  { $match: { $expr: { $in: ['$orderId', ['$$a', '$$b']] } } },
                  { $project: { agentName: 1 } },
                  { $limit: 1 }
                ],
                as: 'my'
              }
            },
            // Pull the first agentName directly from the array returned by $lookup
            { $addFields: { agentName: { $arrayElemAt: ['$my.agentName', 0] } } },

            {
              $lookup: {
                from: 'escalations',
                let: { a: '$oWithHash', b: '$oWithoutHash' },
                pipeline: [
                  { $match: { $expr: { $in: ['$orderId', ['$$a', '$$b']] } } },
                  { $project: { _id: 1 } },
                  { $limit: 1 }
                ],
                as: 'esc'
              }
            },
            { $addFields: { hasEscalation: { $gt: [{ $size: '$esc' }, 0] } } },

            // Lookup Shopify order by orderName (exact match)
            {
              $lookup: {
                from: 'shopifyorders',
                let: { a: '$oWithHash', b: '$oWithoutHash' },
                pipeline: [
                  { $match: { $expr: { $in: ['$orderName', ['$$a', '$$b']] } } },
                  { $project: { amount: 1, productsOrdered: 1 } },
                  { $limit: 1 }
                ],
                as: 'shop'
              }
            },
            { $addFields: { shop: { $arrayElemAt: ['$shop', 0] } } },

            // Build product abbreviations on the small, paged set
            {
              $addFields: {
                productsAbbrev: {
                  $cond: [
                    { $isArray: '$shop.productsOrdered' },
                    {
                      $map: {
                        input: '$shop.productsOrdered',
                        as: 'p',
                        in: {
                          $let: {
                            vars: {
                              cleanTitle: {
                                $replaceAll: {
                                  input: {
                                    $replaceAll: {
                                      input: { $ifNull: ['$$p.title', ''] },
                                      find: '-',
                                      replacement: ' '
                                    }
                                  },
                                  find: '–',
                                  replacement: ' '
                                }
                              }
                            },
                            in: {
                              $reduce: {
                                input: {
                                  $filter: {
                                    input: { $split: ['$$cleanTitle', ' '] },
                                    as: 'w',
                                    cond: { $gt: [{ $strLenCP: '$$w' }, 0] }
                                  }
                                },
                                initialValue: '',
                                in: { $concat: ['$$value', { $toUpper: { $substrCP: ['$$this', 0, 1] } }] }
                              }
                            }
                          }
                        }
                      }
                    },
                    []
                  ]
                }
              }
            },

            // Final projection
            {
              $project: {
                _id: 1,
                order_id: 1,
                contact_number: 1,
                full_name: 1,
                shipment_status: 1,
                order_date: 1,
                tracking_number: 1,
                carrier_title: 1,
                priority: 1,
                hasEscalation: 1,
                issue: 1,
                amount: { $ifNull: ['$shop.amount', null] },
                productsAbbrev: 1,
                agentName: 1 // <— NEW
              }
            }
          ],

          // ===== TOTAL =====
          total: [
            ...(priorityFilter ? [{ $match: { priority: priorityFilter } }] : []),
            { $count: 'total' }
          ],

          // ===== COUNTS (by priority) =====
          counts: [
            { $group: { _id: '$priority', count: { $sum: 1 } } }
          ],

          // ===== STATUSES (facet list) =====
          statuses: [
            { $group: { _id: '$shipment_status' } },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ];

    const agg = await Order.aggregate(pipeline)
      .allowDiskUse(true)
      .option({ maxTimeMS: 30000 });

    const doc = agg[0] || { rows: [], total: [], counts: [], statuses: [] };

    const total = doc.total?.[0]?.total || 0;

    const counts = { High: 0, Medium: 0, Low: 0 };
    (doc.counts || []).forEach(c => { counts[c._id] = c.count; });

    res.json({
      page,
      limit,
      total,
      counts,
      data: doc.rows || [],
      facets: {
        statuses: (doc.statuses || []).map(s => s._id).filter(Boolean)
      }
    });
  } catch (err) {
    console.error('GET /api/orders/undelivered error:', err);
    res.status(500).json({ error: 'Failed to fetch undelivered orders.' });
  }
});

// PATCH /api/orders/:id/issue  { issue: "fakeRemark" | "anything" }
router.patch('/:id/issue', async (req, res) => {
  try {
    const { id } = req.params;
    let { issue } = req.body;

    if (issue == null) issue = '';
    if (typeof issue !== 'string') issue = String(issue);
    issue = issue.trim();

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: 'Invalid order id.' });
    }

    const updated = await Order.findByIdAndUpdate(
      id,
      { $set: { issue } },
      { new: true, projection: { _id: 1, order_id: 1, issue: 1 } }
    );

    if (!updated) return res.status(404).json({ error: 'Order not found.' });

    res.json({ ok: true, order: updated });
  } catch (err) {
    console.error('PATCH /api/orders/:id/issue error:', err);
    res.status(500).json({ error: 'Failed to update issue.' });
  }
});

module.exports = router;
