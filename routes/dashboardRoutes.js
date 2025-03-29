const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');

// Helper: parse date range from query
function parseDateRange(req) {
  const { startDate, endDate } = req.query;
  // If either is missing or invalid, fallback to "today"
  const now = new Date().toISOString().split("T")[0];
  const sDate = startDate && startDate.length === 10 ? startDate : now;
  const eDate = endDate && endDate.length === 10 ? endDate : now;
  return { sDate, eDate };
}

/* -------------------------
   1) /api/dashboard/today-summary-agent
   Accepts: agentAssignedName, startDate, endDate
------------------------- */
router.get('/today-summary-agent', async (req, res) => {
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
          leadsAssignedToday: { $sum: 1 },
          openLeads: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$salesStatus", "On Follow Up"] },
                    { $eq: ["$salesStatus", ""] }
                  ]
                },
                1,
                0
              ]
            }
          },
          salesDone: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0] }
          },
          totalSales: { $sum: { $ifNull: ["$amountPaid", 0] } }
        }
      },
      {
        $addFields: {
          conversionRate: {
            $cond: [
              { $gt: ["$leadsAssignedToday", 0] },
              { $multiply: [{ $divide: ["$salesDone", "$leadsAssignedToday"] }, 100] },
              0
            ]
          },
          avgOrderValue: {
            $cond: [
              { $gt: ["$salesDone", 0] },
              { $divide: ["$totalSales", "$salesDone"] },
              0
            ]
          }
        }
      },
      {
        $project: {
          _id: 0,
          openLeads: 1,
          leadsAssignedToday: 1,
          salesDone: 1,
          conversionRate: { $round: ["$conversionRate", 2] },
          totalSales: { $round: ["$totalSales", 2] },
          avgOrderValue: { $round: ["$avgOrderValue", 2] }
        }
      }
    ];

    const result = await Lead.aggregate(pipeline);
    if (result.length === 0) {
      return res.json({
        openLeads: 0,
        leadsAssignedToday: 0,
        salesDone: 0,
        conversionRate: 0,
        totalSales: 0,
        avgOrderValue: 0
      });
    }
    res.json(result[0]);
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

  router.get("/delivery-status-summary-limited", async (req, res) => {
    try {
      const { agentAssignedName, startDate, endDate } = req.query;
  
      // If no valid date, default to "today"
      const sDate = parseDate(startDate) || new Date().toISOString().split("T")[0];
      const eDate = parseDate(endDate) || new Date().toISOString().split("T")[0];
  
      // We only care about leads that are "Sales Done"
      const matchCriteria = {
        date: { $gte: sDate, $lte: eDate },
        salesStatus: "Sales Done",
      };
      if (agentAssignedName) {
        matchCriteria.agentAssigned = agentAssignedName;
      }
  
      // Aggregate: group by deliveryStatus, counting how many & summing amountPaid
      const pipeline = [
        { $match: matchCriteria },
        {
          $group: {
            _id: "$deliveryStatus",
            totalOrders: { $sum: 1 },
            totalAmount: { $sum: { $ifNull: ["$amountPaid", 0] } },
          },
        },
      ];
  
      const result = await Lead.aggregate(pipeline);
  
      // Summation of everything for "Total Orders"
      const grandTotal = result.reduce((acc, r) => acc + r.totalOrders, 0);
      const grandAmount = result.reduce((acc, r) => acc + r.totalAmount, 0);
  
      // Utility to find & pop from result or return 0
      function findAndRemove(deliveryKey) {
        const idx = result.findIndex((r) => r._id === deliveryKey);
        if (idx === -1) return { totalOrders: 0, totalAmount: 0 };
        const item = result[idx];
        // remove it from the array so we can handle "Others" next
        result.splice(idx, 1);
        return item;
      }
  
      // 1) total => from aggregator or just use the sums
      const summaryArray = [];
      summaryArray.push({
        label: "Total Orders",
        totalOrders: grandTotal,
        totalAmount: grandAmount,
        percentage: grandTotal > 0 ? 100 : 0,
      });
  
      // 2) delivered
      const delivered = findAndRemove("Delivered");
      summaryArray.push({
        label: "Delivered Orders",
        totalOrders: delivered.totalOrders,
        totalAmount: delivered.totalAmount,
        percentage:
          grandTotal > 0
            ? ((delivered.totalOrders / grandTotal) * 100).toFixed(2)
            : 0,
      });
  
      // 3) in transit => your code says "Undelivered" means in transit
      const inTransit = findAndRemove("Undelivered");
      summaryArray.push({
        label: "In Transit",
        totalOrders: inTransit.totalOrders,
        totalAmount: inTransit.totalAmount,
        percentage:
          grandTotal > 0
            ? ((inTransit.totalOrders / grandTotal) * 100).toFixed(2)
            : 0,
      });
  
      // 4) RTO
      const rto = findAndRemove("RTO");
      summaryArray.push({
        label: "RTO",
        totalOrders: rto.totalOrders,
        totalAmount: rto.totalAmount,
        percentage:
          grandTotal > 0 ? ((rto.totalOrders / grandTotal) * 100).toFixed(2) : 0,
      });
  
      // 5) "Others" => everything else in result
      const othersOrders = result.reduce((acc, r) => acc + r.totalOrders, 0);
      const othersAmount = result.reduce((acc, r) => acc + r.totalAmount, 0);
      summaryArray.push({
        label: "Others",
        totalOrders: othersOrders,
        totalAmount: othersAmount,
        percentage:
          grandTotal > 0 ? ((othersOrders / grandTotal) * 100).toFixed(2) : 0,
      });
  
      res.json(summaryArray);
    } catch (error) {
      console.error("Error in delivery-status-summary-limited:", error);
      res
        .status(500)
        .json({ message: "Error fetching delivery-status-summary-limited" });
    }
  });

module.exports = router;
