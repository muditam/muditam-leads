const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');

// GET /api/sales-summary
router.get('/sales-summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // Default to "today" if not provided
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    // Updated pipeline: using lastOrderDate for filtering sales metrics
    const perAgentPipeline = [
      {
        $match: {
          lastOrderDate: { $gte: sDate, $lte: eDate },
        },
      },
      {
        $group: {
          _id: "$agentAssigned",
          openLeads: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "On Follow Up"] }, 1, 0] },
          },
          leadsAssignedToday: { $sum: 1 },
          salesDone: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0] },
          },
          totalSales: { $sum: { $ifNull: ["$amountPaid", 0] } },
          totalLeads: { $sum: 1 },
        },
      },
      {
        $addFields: {
          conversionRate: {
            $cond: [
              { $gt: ["$leadsAssignedToday", 0] },
              { $multiply: [{ $divide: ["$salesDone", "$leadsAssignedToday"] }, 100] },
              0,
            ],
          },
          avgOrderValue: {
            $cond: [
              { $gt: ["$salesDone", 0] },
              { $divide: ["$totalSales", "$salesDone"] },
              0,
            ],
          },
        },
      },
      {
        $project: {
          agentName: "$_id",
          _id: 0,
          openLeads: 1,
          leadsAssignedToday: 1,
          salesDone: 1,
          conversionRate: { $round: ["$conversionRate", 2] },
          totalSales: { $round: ["$totalSales", 2] },
          avgOrderValue: { $round: ["$avgOrderValue", 2] },
          totalLeads: 1,
        },
      },
    ];
    const perAgentData = await Lead.aggregate(perAgentPipeline);

    // Overall sales summary pipeline updated similarly
    const overallPipeline = [
      {
        $match: {
          lastOrderDate: { $gte: sDate, $lte: eDate },
        },
      },
      {
        $group: {
          _id: null,
          openLeads: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "On Follow Up"] }, 1, 0] },
          },
          leadsAssignedToday: { $sum: 1 },
          salesDone: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0] },
          },
          totalSales: { $sum: { $ifNull: ["$amountPaid", 0] } },
        },
      },
      {
        $addFields: {
          conversionRate: {
            $cond: [
              { $gt: ["$leadsAssignedToday", 0] },
              { $multiply: [{ $divide: ["$salesDone", "$leadsAssignedToday"] }, 100] },
              0,
            ],
          },
          avgOrderValue: {
            $cond: [
              { $gt: ["$salesDone", 0] },
              { $divide: ["$totalSales", "$salesDone"] },
              0,
            ],
          },
        },
      },
      {
        $project: {
          _id: 0,
          openLeads: 1,
          leadsAssignedToday: 1,
          salesDone: 1,
          conversionRate: { $round: ["$conversionRate", 2] },
          totalSales: { $round: ["$totalSales", 2] },
          avgOrderValue: { $round: ["$avgOrderValue", 2] },
        },
      },
    ];
    const overallDataArr = await Lead.aggregate(overallPipeline);
    const overallData = overallDataArr[0] || {};

    res.json({ perAgent: perAgentData, overall: overallData });
  } catch (error) {
    console.error("Error fetching sales summary:", error);
    res.status(500).json({ message: "Error fetching sales summary" });
  }
});

// GET /api/followup-summary
router.get('/followup-summarys', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    const pipeline = [
      {
        $match: {
          date: { $gte: sDate, $lte: eDate },
        },
      },
      {
        $group: {
          _id: "$agentAssigned",
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
          agentName: "$_id",
          _id: 0,
          noFollowupSet: 1,
          followupMissed: 1,
          followupToday: 1,
          followupTomorrow: 1,
          followupLater: 1,
        },
      },
    ];

    const results = await Lead.aggregate(pipeline);
    res.json({ followup: results });
  } catch (error) {
    console.error("Error fetching followup summary:", error);
    res.status(500).json({ message: "Error fetching followup summary" });
  }
});

// GET /api/lead-source-summary
router.get('/lead-source-summary', async (req, res) => {
  try {
    const { startDate, endDate, agentAssignedName } = req.query;
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    const matchCriteria = { date: { $gte: sDate, $lte: eDate } };
    if (agentAssignedName && agentAssignedName !== "All Agents") {
      matchCriteria.agentAssigned = agentAssignedName;
    }

    const pipeline = [
      { $match: matchCriteria },
      {
        $group: {
          _id: "$leadSource",
          leadsAssigned: { $sum: 1 },
          leadsConverted: {
            $sum: { $cond: [{ $eq: ["$salesStatus", "Sales Done"] }, 1, 0] },
          },
          salesAmount: { $sum: { $ifNull: ["$amountPaid", 0] } },
        },
      },
      {
        $addFields: {
          conversionRate: {
            $cond: [
              { $gt: ["$leadsAssigned", 0] },
              { $multiply: [{ $divide: ["$leadsConverted", "$leadsAssigned"] }, 100] },
              0,
            ],
          },
        },
      },
      {
        $project: {
          leadSource: "$_id",
          _id: 0,
          leadsAssigned: 1,
          leadsConverted: 1,
          conversionRate: { $round: ["$conversionRate", 2] },
          salesAmount: { $round: ["$salesAmount", 2] },
        },
      },
    ];

    const results = await Lead.aggregate(pipeline);
    res.json({ leadSourceSummary: results });
  } catch (error) {
    console.error("Error fetching lead source summary:", error);
    res.status(500).json({ message: "Error fetching lead source summary" });
  }
});


module.exports = router;
