const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const MyOrder = require('../models/MyOrder'); 

function parseDateRange(req) {
  const { startDate, endDate } = req.query;
  const now = new Date().toISOString().split("T")[0]; // e.g. "2025-04-02"
  const sDate = startDate && startDate.length === 10 ? startDate : now;
  const eDate = endDate && endDate.length === 10 ? endDate : now;
  return { sDate, eDate };
}

router.get('/today-summary-agent', async (req, res) => {
  try {
    const agentName = req.query.agentAssignedName;
    const { sDate, eDate } = parseDateRange(req);

    // ------------------------------
    // 1) Aggregate data from Lead collection
    // ------------------------------
    const leadMatch = { date: { $gte: sDate, $lte: eDate } };
    if (agentName) {
      leadMatch.agentAssigned = agentName;
    }
    const leadPipeline = [
      { $match: leadMatch },
      {
        $group: {
          _id: null,
          leadsAssignedToday: { $sum: 1 },
          openLeads: {
            $sum: {
              $cond: [
                { $or: [{ $eq: ["$salesStatus", "On Follow Up"] }, { $eq: ["$salesStatus", ""] }] },
                1,
                0
              ]
            }
          },
          salesDone: { $sum: { $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0] } },
          totalSales: { $sum: { $ifNull: ["$amountPaid", 0] } }
        }
      }
    ];
    const leadResult = await Lead.aggregate(leadPipeline);
    const leadData = leadResult[0] || { leadsAssignedToday: 0, openLeads: 0, salesDone: 0, totalSales: 0 };

    // ------------------------------
    // 2) Aggregate data from MyOrder collection
    // ------------------------------
    const myOrderMatch = {};
    if (agentName) {
      myOrderMatch.agentName = agentName;
    }
    // IMPORTANT: Use sDate for start and eDate for end boundaries
    const startDateObj = new Date(sDate + "T00:00:00+05:30");
    const endDateObj = new Date(eDate + "T23:59:59.999+05:30");
    myOrderMatch.orderDate = { $gte: startDateObj, $lte: endDateObj };

    // For MyOrder, count each order as one sale and compute totalSales as:
    // if upsellAmount > 0 then upsellAmount, else totalPrice.
    const orderPipeline = [
      { $match: myOrderMatch },
      {
        $group: {
          _id: null,
          leadsAssignedToday: { $sum: 1 },
          salesDone: { $sum: 1 },
          totalSales: {
            $sum: {
              $cond: [
                { $gt: ["$upsellAmount", 0] },
                { $toDouble: "$upsellAmount" },
                { $toDouble: "$totalPrice" }
              ]
            }
          }
        }
      }
    ];
    const orderResult = await MyOrder.aggregate(orderPipeline);
    const orderData = orderResult[0] || { leadsAssignedToday: 0, salesDone: 0, totalSales: 0 };

    // ------------------------------
    // 3) Combine the results
    // ------------------------------
    const combinedLeadsAssigned = leadData.leadsAssignedToday + orderData.leadsAssignedToday;
    const combinedSalesDone = leadData.salesDone + orderData.salesDone;
    const combinedTotalSales = leadData.totalSales + orderData.totalSales;
    // Open leads come only from Lead collection.
    const openLeads = leadData.openLeads;

    const conversionRate =
      combinedLeadsAssigned > 0 ? (combinedSalesDone / combinedLeadsAssigned) * 100 : 0;
    const avgOrderValue =
      combinedSalesDone > 0 ? combinedTotalSales / combinedSalesDone : 0;

    res.json({
      openLeads,
      leadsAssignedToday: combinedLeadsAssigned,
      salesDone: combinedSalesDone,
      conversionRate: Number(conversionRate.toFixed(2)),
      totalSales: Number(combinedTotalSales.toFixed(2)),
      avgOrderValue: Number(avgOrderValue.toFixed(2))
    });
  } catch (error) {
    console.error("Error in today-summary-agent:", error);
    res.status(500).json({ message: "Error in today-summary-agent" });
  }
});


/* -------------------------
   2) /api/dashboard/followup-summary-agent
   Accepts: agentAssignedName, startDate, endDate
------------------------- */
router.get('/followup-summary-agent', async (req, res) => {
  try {
    const agentName = req.query.agentAssignedName;
    const { sDate, eDate } = parseDateRange(req);

    // Build match criteria
    const matchCriteria = {
      date: { $gte: sDate, $lte: eDate },
    };
    if (agentName) {
      matchCriteria.agentAssigned = agentName;
    }

    const pipeline = [
      { $match: matchCriteria },
      {
        $group: {
          _id: null,
          noFollowupSet: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$nextFollowup", null] },
                    { $eq: ["$nextFollowup", ""] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          followupMissed: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$nextFollowup", null] },
                    { $ne: ["$nextFollowup", ""] },
                    { $lt: ["$nextFollowup", sDate] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          followupToday: {
            $sum: { $cond: [{ $eq: ["$nextFollowup", sDate] }, 1, 0] },
          },
          followupTomorrow: {
            $sum: { $cond: [{ $eq: ["$nextFollowup", eDate] }, 1, 0] },
          },
          followupLater: {
            $sum: { $cond: [{ $gt: ["$nextFollowup", eDate] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          noFollowupSet: 1,
          followupMissed: 1,
          followupToday: 1,
          followupTomorrow: 1,
          followupLater: 1,
        },
      },
    ];

    const result = await Lead.aggregate(pipeline);
    if (result.length === 0) {
      return res.json({
        noFollowupSet: 0,
        followupMissed: 0,
        followupToday: 0,
        followupTomorrow: 0,
        followupLater: 0,
      });
    }
    res.json(result[0]);
  } catch (error) {
    console.error("Error in followup-summary-agent:", error);
    res.status(500).json({ message: "Error in followup-summary-agent" });
  }
});

// Helper: parse date from query or fallback
function parseDate(str) {
    if (!str) return null;
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : str; // Return the string if valid
  }
  
  /**
   * GET /api/dashboard/lead-source-summary-limited
   * Query params:
   *   agentAssignedName, startDate, endDate
   */
  router.get('/lead-source-summary-limited', async (req, res) => {
    try {
      const { agentAssignedName, startDate, endDate } = req.query;
  
      // If no valid start/end, fallback to "today"
      const sDate = parseDate(startDate) || new Date().toISOString().split("T")[0];
      const eDate = parseDate(endDate) || new Date().toISOString().split("T")[0];
  
      const matchCriteria = {
        date: { $gte: sDate, $lte: eDate },
      };
      if (agentAssignedName) {
        matchCriteria.agentAssigned = agentAssignedName;
      }
  
      // Aggregation pipeline that only returns aggregated data (NOT all leads)
      const pipeline = [
        { $match: matchCriteria },
        {
          $group: {
            _id: "$leadSource",
            leadsAssigned: { $sum: 1 },
            leadsConverted: {
              $sum: {
                $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0],
              },
            },
            salesAmount: {
              $sum: { $ifNull: ["$amountPaid", 0] },
            },
          },
        },
        {
          $addFields: {
            conversionRate: {
              $cond: [
                { $gt: ["$leadsAssigned", 0] },
                {
                  $multiply: [
                    { $divide: ["$leadsConverted", "$leadsAssigned"] },
                    100,
                  ],
                },
                0,
              ],
            },
          },
        },
        {
          $project: {
            _id: 0,
            leadSource: "$_id",
            leadsAssigned: 1,
            leadsConverted: 1,
            conversionRate: { $round: ["$conversionRate", 2] },
            salesAmount: { $round: ["$salesAmount", 2] },
          },
        },
      ];
  
      const result = await Lead.aggregate(pipeline);
      res.json(result);
    } catch (error) {
      console.error("Error in lead-source-summary-limited:", error);
      res
        .status(500)
        .json({ message: "Error fetching lead-source-summary-limited" });
    }
  });

  router.get('/shipment-status-summary', async (req, res) => {
    try {
      const { startDate, endDate, agentName } = req.query;
      // Use provided dates or default to today
      const sDate = startDate || new Date().toISOString().split("T")[0];
      const eDate = endDate || new Date().toISOString().split("T")[0];
  
      // Convert start and end into Date objects.
      const start = new Date(sDate);
      const end = new Date(eDate);
      // To include the entire end date, add one day and use $lt.
      const nextDay = new Date(end);
      nextDay.setDate(end.getDate() + 1);
  
      // Build match criteria for MyOrder
      const matchCriteria = {
        orderDate: { $gte: start, $lt: nextDay }
      };
      if (agentName && agentName !== "All Agents") {
        matchCriteria.agentName = agentName;
      }
  
      const pipeline = [
        // Normalize orderId: remove a leading "#" if present.
        {
          $addFields: {
            normalizedOrderId: {
              $cond: [
                { $eq: [ { $substr: ["$orderId", 0, 1] }, "#" ] },
                { $substr: [ "$orderId", 1, { $subtract: [ { $strLenCP: "$orderId" }, 1 ] } ] },
                "$orderId"
              ]
            }
          }
        },
        { $match: matchCriteria },
        {
          $lookup: {
            from: "orders", // Ensure this matches your Order collection name (often in lowercase)
            let: { normId: "$normalizedOrderId" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$order_id", "$$normId"] }
                }
              },
              { $project: { shipment_status: 1, _id: 0 } }
            ],
            as: "orderData"
          }
        },
        {
          $addFields: {
            shipmentStatus: {
              $cond: [
                { $gt: [ { $size: "$orderData" }, 0 ] },
                { $arrayElemAt: [ "$orderData.shipment_status", 0 ] },
                "Not available"
              ]
            }
          }
        },
        {
          $group: {
            _id: "$shipmentStatus",
            totalOrders: { $sum: 1 },
            totalAmount: { $sum: "$totalPrice" }
          }
        },
        {
          $project: {
            _id: 0,
            category: "$_id",
            totalOrders: 1,
            totalAmount: { $round: ["$totalAmount", 2] }
          }
        }
      ];
  
      const summary = await MyOrder.aggregate(pipeline);
      const overall = await MyOrder.countDocuments(matchCriteria);
  
      // Calculate percentage for each category.
      const summaryWithPercentage = summary.map(item => ({
        ...item,
        percentage: overall > 0 ? ((item.totalOrders / overall) * 100).toFixed(2) : "0.00"
      }));
  
      res.json({ shipmentStatusSummary: summaryWithPercentage });
    } catch (error) {
      console.error("Error fetching shipment status summary:", error);
      res.status(500).json({ message: "Error fetching shipment status summary", error: error.message });
    }
  });

module.exports = router;
