const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const MyOrder = require('../models/MyOrder'); 
const Order = require("../models/Order");
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
    // Use provided dates or default to today's date (format: YYYY-MM-DD)
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    // For the Lead collection, assume the "date" field stores the lead's added date as a string "YYYY-MM-DD"
    const leadStartDate = sDate;
    const leadEndDate = eDate;

    // For MyOrder, convert the dates into Date objects.
    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);

    // Fetch the list of Sales Agents
    const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName email");
    const salesAgentNames = salesAgents.map(agent => agent.fullName);

    // ----- Overall Metrics -----
    const leadsAssignedCount = await Lead.countDocuments({
      date: { $gte: leadStartDate, $lte: leadEndDate },
      agentAssigned: { $in: salesAgentNames }
    });

    const openLeadsCount = await Lead.countDocuments({
      agentAssigned: { $in: salesAgentNames },
      $or: [
        // Use $toLower to make comparison case-insensitive.
        { $expr: { $eq: [ { $toLower: "$salesStatus" }, "on followup" ] } },
        { $expr: { $in: [ { $toLower: "$salesStatus" }, [ "", null ] ] } }
      ]
    });
    // ----------------------------

    // Lead pipeline: compute per-agent leadsAssigned and openLeads.
    const leadPipeline = [
      {
        $match: {
          date: { $gte: leadStartDate, $lte: leadEndDate },
          agentAssigned: { $in: salesAgentNames }
        }
      },
      {
        $group: {
          _id: "$agentAssigned",
          leadsAssigned: { $sum: 1 },
          openLeads: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: [ { $toLower: "$salesStatus" }, "on followup" ] },
                    { $in: [ { $toLower: "$salesStatus" }, [ "", null ] ] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ];
    const leadData = await Lead.aggregate(leadPipeline);

    // Order pipeline: deduplicate orders per agent by grouping on agentName and orderId.
    const orderPipeline = [
      {
        $match: {
          orderDate: { $gte: orderStartDate, $lte: orderEndDate },
          agentName: { $in: salesAgentNames }
        }
      },
      {
        $project: {
          agentName: 1,
          orderId: 1,
          orderPrice: { $ifNull: ["$totalPrice", { $ifNull: ["$amountPaid", 0] }] }
        }
      },
      {
        $group: {
          _id: { agentName: "$agentName", orderId: "$orderId" },
          orderPrice: { $first: "$orderPrice" }
        }
      },
      {
        $group: {
          _id: "$_id.agentName",
          orderCount: { $sum: 1 },
          orderSalesAmount: { $sum: "$orderPrice" }
        }
      }
    ];
    const orderData = await MyOrder.aggregate(orderPipeline);

    // Merge per-agent data:
    const orderMap = {};
    orderData.forEach(item => {
      orderMap[item._id] = item;
    });
    const perAgent = leadData.map(item => {
      const agent = item._id;
      const orderInfo = orderMap[agent] || { orderCount: 0, orderSalesAmount: 0 };
      const leadsAssigned = item.leadsAssigned;
      const openLeads = item.openLeads;
      // Use only MyOrder data for sales done and total sales.
      const salesDone = orderInfo.orderCount;
      const totalSales = orderInfo.orderSalesAmount;
      const conversionRate = leadsAssigned > 0 ? (salesDone / leadsAssigned) * 100 : 0;
      const avgOrderValue = salesDone > 0 ? (totalSales / salesDone) : 0;
      return {
        agentName: agent,
        leadsAssigned,
        openLeads,
        salesDone,
        totalSales: Number(totalSales.toFixed(2)),
        conversionRate: Number(conversionRate.toFixed(2)),
        avgOrderValue: Number(avgOrderValue.toFixed(2))
      };
    });

    // Overall summary:
    const overallOrder = orderData.reduce((acc, item) => {
      acc.orderCount += item.orderCount;
      acc.orderSalesAmount += item.orderSalesAmount;
      return acc;
    }, { orderCount: 0, orderSalesAmount: 0 });
    const overallSalesDone = overallOrder.orderCount;
    const overallTotalSales = overallOrder.orderSalesAmount;
    const overallConversionRate = leadsAssignedCount > 0 ? (overallSalesDone / leadsAssignedCount) * 100 : 0;
    const overallAvgOrderValue = overallSalesDone > 0 ? (overallTotalSales / overallSalesDone) : 0;

    const overall = {
      leadsAssigned: leadsAssignedCount,
      salesDone: overallSalesDone,
      totalSales: Number(overallTotalSales.toFixed(2)),
      conversionRate: Number(overallConversionRate.toFixed(2)),
      avgOrderValue: Number(overallAvgOrderValue.toFixed(2)),
      overallLeadsAssigned: leadsAssignedCount,
      openLeads: openLeadsCount
    };

    res.json({ perAgent, overall });
  } catch (error) {
    console.error("Error fetching sales summary:", error);
    res.status(500).json({ message: "Error fetching sales summary", error: error.message });
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

router.get('/all-shipment-summary', async (req, res) => {
  try {
    // Validate query parameters: startDate and endDate must be provided and non-empty.
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate || !startDate.trim() || !endDate.trim()) {
      return res.status(400).json({ message: "startDate and endDate query parameters are required" });
    }
    
    // Convert the query parameters to Date objects.
    const sDate = new Date(startDate);
    const eDate = new Date(endDate);
    if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) {
      return res.status(400).json({ message: "Invalid startDate or endDate" });
    }
    
    // Include the entire end day.
    eDate.setHours(23, 59, 59, 999);
    
    // Build the aggregation pipeline.
    const pipeline = [
      // 1) Match orders in the provided date range (using order_date from the Order collection)
      { 
        $match: { 
          order_date: { $gte: sDate, $lte: eDate }
        } 
      },
      // 2) Create a normalized order ID field by trimming any leading '#' from order_id.
      { 
        $addFields: { 
          normOrderId: { $trim: { input: "$order_id", chars: "#" } }
        } 
      },
      // 3) Lookup matching MyOrder documents using normOrderId and MyOrder's orderId.
      { 
        $lookup: {
          from: "myorders", // this should match the actual collection name for MyOrder (Mongoose pluralizes the model name)
          localField: "normOrderId",
          foreignField: "orderId",
          as: "myorderInfo"
        } 
      },
      // 4) Unwind the lookup array; if no matching MyOrder is found, preserve the document with a null myorderInfo.
      { 
        $unwind: { 
          path: "$myorderInfo", 
          preserveNullAndEmptyArrays: true 
        } 
      },
      // 5) Add an "amount" field; if myorderInfo.totalPrice exists, use it, otherwise default to 0.
      { 
        $addFields: { 
          amount: { $ifNull: ["$myorderInfo.totalPrice", 0] }
        } 
      },
      // 6) Group the orders by shipment_status.
      { 
        $group: { 
          _id: "$shipment_status", 
          count: { $sum: 1 }, 
          totalAmount: { $sum: "$amount" }
        } 
      }
    ];
    
    const aggResults = await Order.aggregate(pipeline);
     
    const totalCount = aggResults.reduce((sum, doc) => sum + doc.count, 0);
     
    const result = aggResults.map(doc => ({
      category: doc._id ? doc._id : "Not Provided",
      count: doc.count,
      amount: Number(doc.totalAmount.toFixed(2)),
      percentage: totalCount > 0 ? Number(((doc.count / totalCount) * 100).toFixed(2)) : 0
    }));
    
    res.json(result);
  } catch (error) {
    console.error("Error fetching shipment summary:", error);
    res.status(500).json({ message: "Error fetching shipment summary", error: error.message });
  }
});

module.exports = router;
