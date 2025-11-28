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


    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);


    // Step 1: Fetch Sales Agents
    const salesAgents = await Employee.find(
      { role: "Sales Agent" },
      "fullName"
    );
    const salesAgentNames = salesAgents.map((a) => a.fullName);


    // Step 2: Aggregation to get leadsAssigned and openLeads
    const leadsAgg = await Lead.aggregate([
      {
        $match: {
          date: { $gte: sDate, $lte: eDate },
          agentAssigned: { $in: salesAgentNames },
        },
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
                    { $eq: [{ $toLower: "$salesStatus" }, "on followup"] },
                    { $eq: ["$salesStatus", null] },
                    { $eq: ["$salesStatus", ""] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);


    const leadsAssignedCount = leadsAgg.reduce(
      (sum, a) => sum + a.leadsAssigned,
      0
    );
    const perAgentLeads = {};
    leadsAgg.forEach((agent) => {
      perAgentLeads[agent._id] = {
        leadsAssigned: agent.leadsAssigned,
        openLeads: agent.openLeads,
      };
    });


    // Step 3: Get open leads count for all sales agents
    const openLeadsAllAgg = await Lead.aggregate([
      {
        $match: {
          agentAssigned: { $in: salesAgentNames },
          $or: [
            { salesStatus: null },
            { salesStatus: "" },
            { salesStatus: { $regex: /^on followup$/i } },
          ],
        },
      },
      { $count: "openLeads" },
    ]);
    const openLeadsCount = openLeadsAllAgg[0]?.openLeads || 0;


    // Step 4: Aggregation for order data per agent
    const ordersAgg = await MyOrder.aggregate([
      {
        $match: {
          orderDate: { $gte: orderStartDate, $lte: orderEndDate },
          agentName: { $in: salesAgentNames },
        },
      },
      {
        $group: {
          _id: { agentName: "$agentName", orderId: "$orderId" },
          totalPrice: {
            $first: {
              $ifNull: ["$totalPrice", "$amountPaid"],
            },
          },
        },
      },
      {
        $group: {
          _id: "$_id.agentName",
          orderCount: { $sum: 1 },
          orderSalesAmount: { $sum: "$totalPrice" },
        },
      },
    ]);


    const agentOrderStats = {};
    ordersAgg.forEach((agent) => {
      agentOrderStats[agent._id] = {
        orderCount: agent.orderCount,
        orderSalesAmount: agent.orderSalesAmount,
      };
    });


    // Step 5: Merge stats
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


    // Step 6: Overall stats
    const overallSalesDone = ordersAgg.reduce(
      (sum, a) => sum + a.orderCount,
      0
    );
    const overallTotalSales = ordersAgg.reduce(
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
    res.status(500).json({
      message: "Error fetching sales summary",
      error: error.message,
    });
  }
});

router.get("/followup-summarys", async (req, res) => {
  try {
    // 1. Get all sales agents (always included in response)
    const salesAgents = await Employee.find(
      { role: "Sales Agent", status: "active" },
      "fullName"
    );
    const salesAgentNames = salesAgents.map((a) => a.fullName);
    const refDate =
      req.query.referenceDate || new Date().toISOString().split("T")[0];
    const today = refDate;


    // 3. Reference points for nextFollowup logic
    function addDays(dateStr, days) {
      const d = new Date(dateStr);
      d.setDate(d.getDate() + days);
      return d.toISOString().split("T")[0];
    }
    const tomorrow = addDays(today, 1);
    const yesterday = addDays(today, -1);
    const dayAfterTomorrow = addDays(today, 2);


    // 4. Find all leads assigned to any sales agent (NO DATE FILTER!)
    const leads = await Lead.find(
      {
        agentAssigned: { $in: salesAgentNames },
        nextFollowup: { $exists: true },
      },
      {
        agentAssigned: 1,
        nextFollowup: 1,
      }
    ).lean();


    // 5. Build empty stats for every agent
    const agentStats = {};
    salesAgentNames.forEach((name) => {
      agentStats[name] = {
        agentName: name,
        noFollowupSet: 0,
        followupMissed: 0,
        followupToday: 0,
        followupTomorrow: 0,
        followupYesterday: 0,
        followupLater: 0,
      };
    });


    // 6. Fill stats by bucketing each lead according to nextFollowup rules
    leads.forEach((lead) => {
      const stat = agentStats[lead.agentAssigned];
      if (!stat) return;
      const nf = lead.nextFollowup || "";


      if (nf === "") {
        stat.noFollowupSet += 1;
      } else if (nf < today) {
        stat.followupMissed += 1;
      } else if (nf === today) {
        stat.followupToday += 1;
      } else if (nf === tomorrow) {
        stat.followupTomorrow += 1;
      } else if (nf === yesterday) {
        stat.followupYesterday += 1;
      } else if (nf >= dayAfterTomorrow) {
        stat.followupLater += 1;
      }
    });


    // 7. Build final response: one entry per sales agent, always included (even if zero)
    const final = salesAgentNames.map((name) => agentStats[name]);


    res.json({ followup: final });
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

router.get("/cod-prepaid-summary", async (req, res) => {
  try {
    const { startDate, endDate, agentAssignedName } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required (YYYY-MM-DD)",
      });
    }

    // Convert to full-day date range
    const sDate = new Date(startDate);
    const eDate = new Date(endDate);
    eDate.setHours(23, 59, 59, 999);

    // 1️⃣ Get Active Sales Agents
    const salesAgents = await Employee.find(
      { role: "Sales Agent", status: "active" },
      "fullName"
    );

    const agentNames = salesAgents.map((a) => a.fullName);

    let agentFilter = agentNames;
    if (agentAssignedName && agentAssignedName !== "All Agents") {
      agentFilter = [agentAssignedName];
    }

    // ==========================================================
    // 2️⃣ GET ORDERS FROM MYORDER
    // ==========================================================
    const myOrderData = await MyOrder.find(
      {
        orderDate: { $gte: sDate, $lte: eDate },
        agentName: { $in: agentFilter }
      },
      "agentName paymentMethod"
    ).lean();

    // ==========================================================
    // 3️⃣ GET ORDERS FROM LEADS (Sales Done only)
    // ==========================================================
    const leadData = await Lead.find(
      {
        lastOrderDate: { $gte: startDate, $lte: endDate },
        agentAssigned: { $in: agentFilter },
        salesStatus: "Sales Done"
      },
      "agentAssigned modeOfPayment"
    ).lean();

    // ==========================================================
    // 4️⃣ Combine Both Sources
    // ==========================================================
    const combined = [];

    // MyOrder mapped records
    myOrderData.forEach((o) => {
      combined.push({
        agentName: o.agentName,
        method: o.paymentMethod?.toUpperCase?.() || "",
      });
    });

    // Lead mapped records
    leadData.forEach((l) => {
      combined.push({
        agentName: l.agentAssigned,
        method: l.modeOfPayment?.toUpperCase?.() || "",
      });
    });

    // ==========================================================
    // 5️⃣ Build per-agent stats
    // ==========================================================
    const results = [];

    agentFilter.forEach((agent) => {
      const rows = combined.filter((c) => c.agentName === agent);

      const totalOrders = rows.length;
      const codOrders = rows.filter((r) => r.method === "COD").length;
      const prepaidOrders = totalOrders - codOrders;

      const codPercentage = totalOrders > 0 
        ? Number(((codOrders / totalOrders) * 100).toFixed(2))
        : 0;

      const prepaidPercentage = totalOrders > 0 
        ? Number(((prepaidOrders / totalOrders) * 100).toFixed(2))
        : 0;

      results.push({
        agentName: agent,
        totalOrders,
        codOrders,
        prepaidOrders,
        codPercentage,
        prepaidPercentage,
      });
    });

    res.json(results);
  } catch (err) {
    console.error("Error fetching COD vs Prepaid summary:", err);
    res.status(500).json({
      message: "Error fetching COD vs Prepaid summary",
      error: err.message,
    });
  }
});

module.exports = router;

