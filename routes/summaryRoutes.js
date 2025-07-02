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


router.get("/sales-summary", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;


    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];


    const leadStartDate = sDate;
    const leadEndDate = eDate;


    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);


    // 1. Fetch sales agents
    const salesAgents = await Employee.find(
      { role: "Sales Agent" },
      "fullName email"
    );
    const salesAgentNames = salesAgents.map((agent) => agent.fullName);


    // 2. Fetch all leads within date range
    const allLeads = await Lead.find({
      date: { $gte: leadStartDate, $lte: leadEndDate },
      agentAssigned: { $in: salesAgentNames },
    }).lean();


    // 3. Count open leads for all agents
    const allOpenLeads = await Lead.find({
      agentAssigned: { $in: salesAgentNames },
    }).lean();


    const openLeadsCount = allOpenLeads.reduce((count, lead) => {
      const status = (lead.salesStatus || "").toLowerCase();
      if (status === "on followup" || status === "" || status === null) {
        count += 1;
      }
      return count;
    }, 0);


    const leadsAssignedCount = allLeads.length;


    // 4. Compute per-agent leadsAssigned and openLeads manually
    const perAgentLeads = {};


    for (const lead of allLeads) {
      const agent = lead.agentAssigned;
      if (!perAgentLeads[agent]) {
        perAgentLeads[agent] = {
          leadsAssigned: 0,
          openLeads: 0,
        };
      }
      perAgentLeads[agent].leadsAssigned += 1;


      const status = (lead.salesStatus || "").toLowerCase();
      if (status === "on followup" || status === "" || status === null) {
        perAgentLeads[agent].openLeads += 1;
      }
    }


    // 5. Fetch orders and process manually
    const allOrders = await MyOrder.find({
      orderDate: { $gte: orderStartDate, $lte: orderEndDate },
      agentName: { $in: salesAgentNames },
    }).lean();


    const orderMap = {};
    const agentOrderStats = {};


    for (const order of allOrders) {
      const agent = order.agentName;
      const orderKey = `${agent}-${order.orderId}`;
      if (!orderMap[orderKey]) {
        const price = order.totalPrice || order.amountPaid || 0;
        orderMap[orderKey] = true;


        if (!agentOrderStats[agent]) {
          agentOrderStats[agent] = {
            orderCount: 0,
            orderSalesAmount: 0,
          };
        }
        agentOrderStats[agent].orderCount += 1;
        agentOrderStats[agent].orderSalesAmount += price;
      }
    }


    // 6. Merge per-agent stats
    const perAgent = [];


    for (const agent of salesAgentNames) {
      const leadStats = perAgentLeads[agent] || {
        leadsAssigned: 0,
        openLeads: 0,
      };
      const orderStats = agentOrderStats[agent] || {
        orderCount: 0,
        orderSalesAmount: 0,
      };


      const salesDone = orderStats.orderCount;
      const totalSales = orderStats.orderSalesAmount;
      const conversionRate =
        leadStats.leadsAssigned > 0
          ? (salesDone / leadStats.leadsAssigned) * 100
          : 0;
      const avgOrderValue = salesDone > 0 ? totalSales / salesDone : 0;


      const agentSummary = {
        agentName: agent,
        leadsAssigned: leadStats.leadsAssigned,
        openLeads: leadStats.openLeads,
        salesDone,
        totalSales: Number(totalSales.toFixed(2)),
        conversionRate: Number(conversionRate.toFixed(2)),
        avgOrderValue: Number(avgOrderValue.toFixed(2)),
      };


      if (
        agentSummary.leadsAssigned > 0 ||
        agentSummary.openLeads > 0 ||
        agentSummary.salesDone > 0 ||
        agentSummary.totalSales > 0
      ) {
        perAgent.push(agentSummary);
      }
    }


    // 7. Overall Summary
    const overallSalesDone = Object.values(agentOrderStats).reduce(
      (sum, a) => sum + a.orderCount,
      0
    );
    const overallTotalSales = Object.values(agentOrderStats).reduce(
      (sum, a) => sum + a.orderSalesAmount,
      0
    );
    const overallConversionRate =
      leadsAssignedCount > 0
        ? (overallSalesDone / leadsAssignedCount) * 100
        : 0;
    const overallAvgOrderValue =
      overallSalesDone > 0 ? overallTotalSales / overallSalesDone : 0;


    const overall = {
      leadsAssigned: leadsAssignedCount,
      salesDone: overallSalesDone,
      totalSales: Number(overallTotalSales.toFixed(2)),
      conversionRate: Number(overallConversionRate.toFixed(2)),
      avgOrderValue: Number(overallAvgOrderValue.toFixed(2)),
      overallLeadsAssigned: leadsAssignedCount,
      openLeads: openLeadsCount,
    };


    res.json({ perAgent, overall });
  } catch (error) {
    console.error("Error fetching sales summary:", error);
    res
      .status(500)
      .json({ message: "Error fetching sales summary", error: error.message });
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


function parseDateRange(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  e.setHours(23, 59, 59, 999);
  return { s, e };
}
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
    const { startDate, endDate, agentName } = req.query;
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }


    // Build agent filter: specific agent or all Sales Agents
    let agentFilter;
    if (agentName && agentName !== 'All Agents') {
      agentFilter = agentName;
    } else {
      const salesAgents = await Employee.find(
        { role: 'Sales Agent' },
        'fullName'
      );
      agentFilter = { $in: salesAgents.map(a => a.fullName) };
    } 

    const { s, e } = parseDateRange(startDate, endDate);


    const pipeline = [
      // 1) Filter MyOrder by date range & agentName
      {
        $match: {
          orderDate: { $gte: s, $lte: e },
          agentName: agentFilter
        }
      },
      // 2) Normalize orderId (remove leading '#')
      {
        $addFields: {
          normOrderId: { $trim: { input: '$orderId', chars: '#' } }
        }
      },
      // 3) Lookup into Order collection to get shipment_status
      {
        $lookup: {
          from: 'orders',           // your Order collection name
          localField: 'normOrderId',
          foreignField: 'order_id',
          as: 'orderInfo'
        }
      },
      // 4) Unwind orderInfo (keep MyOrder even if no match)
      {
        $unwind: {
          path: '$orderInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      // 5) Compute amount (from MyOrder.totalPrice) and bring in shipment_status
      {
        $addFields: {
          amount: { $ifNull: ['$totalPrice', 0] },
          shipment_status: '$orderInfo.shipment_status'
        }
      },
      // 6) Group by shipment_status
      {
        $group: {
          _id: '$shipment_status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ];


    const agg = await MyOrder.aggregate(pipeline);


    // Compute percentages and format output
    const totalCount = agg.reduce((sum, doc) => sum + doc.count, 0);
    const result = agg.map(doc => ({
      category: doc._id || 'Not Provided',
      count: doc.count,
      amount: Number(doc.totalAmount.toFixed(2)),
      percentage:
        totalCount > 0
          ? Number(((doc.count / totalCount) * 100).toFixed(2))
          : 0
    }));


    res.json(result);
  } catch (err) {
    console.error('Error fetching shipment summary:', err);
    res
      .status(500)
      .json({ message: 'Error fetching shipment summary', error: err.message });
  }
});






module.exports = router;

