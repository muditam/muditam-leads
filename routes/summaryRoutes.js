const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const MyOrder = require('../models/MyOrder'); 
const Employee = require('../models/Employee');

router.get('/sales-order-ids', async (req, res) => {
  try {
    // Get startDate and endDate from query parameters or default to today (YYYY-MM-DD)
    const { startDate, endDate } = req.query;
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    // Convert dates to Date objects; include full end day
    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);

    // Fetch list of Sales Agents (using their fullName)
    const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName");
    const salesAgentNames = salesAgents.map(agent => agent.fullName);

    // Use distinct to get only unique orderId values
    const orderIds = await MyOrder.distinct("orderId", {
      orderDate: { $gte: orderStartDate, $lte: orderEndDate },
      agentName: { $in: salesAgentNames }
    });

    res.json({ orderIds });
  } catch (error) {
    console.error("Error fetching sales order IDs:", error);
    res.status(500).json({ error: "Error fetching sales order IDs" });
  }
});

router.get('/sales-summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // Use provided dates or default to today (format: YYYY-MM-DD)
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    // For the Lead collection, the "date" field is stored as a string "YYYY-MM-DD"
    const leadStartDate = sDate;
    const leadEndDate = eDate;

    // For MyOrder, convert the dates into Date objects.
    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);

    console.log("Order date range:", orderStartDate, orderEndDate);

    // Fetch the list of Sales Agents
    const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName email");
    const salesAgentNames = salesAgents.map(agent => agent.fullName);

    // ----- Additional Metrics -----
    // Leads Assigned: Count of all leads in the date range (regardless of salesStatus)
    const leadsAssignedCount = await Lead.countDocuments({
      date: { $gte: leadStartDate, $lte: leadEndDate }
    });

    // Open Leads: Count of leads where salesStatus is "on followup" OR is null/empty.
    // (Leads with salesStatus "lost" or "sales done" will not match these conditions.)
    const openLeadsCount = await Lead.countDocuments({
      $or: [
        { salesStatus: "on followup" },
        { salesStatus: { $in: [null, ""] } }
      ]
    });
    // ------------------------------

    // Query 1: Aggregate from Lead collection for Sales Done leads
    // Exclude leads that already have an orderId to avoid double-counting.
    const leadPipeline = [
      { 
        $match: { 
          date: { $gte: leadStartDate, $lte: leadEndDate },
          salesStatus: "Sales Done",
          agentAssigned: { $in: salesAgentNames },
          $or: [
            { orderId: { $exists: false } },
            { orderId: "" }
          ]
        }
      },
      { 
        $group: {
          _id: "$agentAssigned",
          leadSalesDone: { $sum: 1 },
          leadSalesAmount: { $sum: { $ifNull: ["$amountPaid", 0] } },
          leadsAssigned: { $sum: 1 }
        }
      }
    ];
    const leadData = await Lead.aggregate(leadPipeline);

    // Query 2: Aggregate from MyOrder collection for orders handled by Sales Agents.
    // Use $addToSet to count only unique orderIds.
    const orderPipeline = [
      {
        $match: {
          orderDate: { $gte: orderStartDate, $lte: orderEndDate },
          agentName: { $in: salesAgentNames }
        }
      },
      {
        $group: {
          _id: "$agentName",
          uniqueOrders: { $addToSet: "$orderId" },
          orderSalesAmount: { $sum: { $ifNull: ["$totalPrice", 0] } }
        }
      },
      {
        $project: {
          orderCount: { $size: "$uniqueOrders" },
          orderSalesAmount: 1
        }
      }
    ];
    const orderData = await MyOrder.aggregate(orderPipeline);

    // Merge per-agent data from Lead and MyOrder collections
    const orderMap = {};
    orderData.forEach(item => {
      orderMap[item._id] = item;
    });
    const perAgent = leadData.map(item => {
      const agent = item._id;
      const orderInfo = orderMap[agent] || { orderCount: 0, orderSalesAmount: 0 };
      const leadsAssigned = item.leadsAssigned;
      // Sales Done = unconverted lead count + unique orders count
      const salesDone = item.leadSalesDone + orderInfo.orderCount;
      // Total Sales = lead amount + order amount
      const totalSales = item.leadSalesAmount + orderInfo.orderSalesAmount;
      const conversionRate = leadsAssigned > 0 ? (salesDone / leadsAssigned) * 100 : 0;
      const avgOrderValue = salesDone > 0 ? (totalSales / salesDone) : 0;
      return {
        agentName: agent,
        leadsAssigned,
        salesDone,
        totalSales: Number(totalSales.toFixed(2)),
        conversionRate: Number(conversionRate.toFixed(2)),
        avgOrderValue: Number(avgOrderValue.toFixed(2))
      };
    });

    // Overall summary across all agents:
    const overallLead = leadData.reduce((acc, item) => {
      acc.leadsAssigned += item.leadsAssigned;
      acc.leadSalesDone += item.leadSalesDone;
      acc.leadSalesAmount += item.leadSalesAmount;
      return acc;
    }, { leadsAssigned: 0, leadSalesDone: 0, leadSalesAmount: 0 });

    const overallOrder = orderData.reduce((acc, item) => {
      acc.orderCount += item.orderCount;
      acc.orderSalesAmount += item.orderSalesAmount;
      return acc;
    }, { orderCount: 0, orderSalesAmount: 0 });

    const overallLeadsAssigned = overallLead.leadsAssigned;
    const overallSalesDone = overallLead.leadSalesDone + overallOrder.orderCount;
    const overallTotalSales = overallLead.leadSalesAmount + overallOrder.orderSalesAmount;
    const overallConversionRate = overallLeadsAssigned > 0 ? (overallSalesDone / overallLeadsAssigned) * 100 : 0;
    const overallAvgOrderValue = overallSalesDone > 0 ? (overallTotalSales / overallSalesDone) : 0;

    const overall = {
      leadsAssigned: overallLeadsAssigned,
      salesDone: overallSalesDone,
      totalSales: Number(overallTotalSales.toFixed(2)),
      conversionRate: Number(overallConversionRate.toFixed(2)),
      avgOrderValue: Number(overallAvgOrderValue.toFixed(2)),
      // Additional metrics:
      overallLeadsAssigned: leadsAssignedCount,
      openLeads: openLeadsCount
    };

    res.json({ perAgent, overall });
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
