const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const MyOrder = require("../models/MyOrder");
const Order = require("../models/Order");
const Employee = require("../models/Employee");

const CUSTOMER_OPEN_STATUSES = [
  "New Lead",
  "CONS Scheduled",
  "CONS Done",
  "Call Back Later",
  "On Follow Up",
  "CNP",
  "Switch Off",
];

router.get("/sales-order-ids", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const sDate = startDate || new Date().toISOString().split("T")[0];
    const eDate = endDate || new Date().toISOString().split("T")[0];

    const orderStartDate = new Date(sDate);
    const orderEndDate = new Date(eDate);
    orderEndDate.setHours(23, 59, 59, 999);

    const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName");
    const salesAgentNames = salesAgents.map((agent) => agent.fullName);

    const orderIds = await MyOrder.distinct("orderId", {
      orderDate: { $gte: orderStartDate, $lte: orderEndDate },
      agentName: { $in: salesAgentNames },
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

    // only active sales agents
    const salesAgents = await Employee.find(
      { role: "Sales Agent", status: "active" },
      "fullName"
    );
    const salesAgentNames = salesAgents.map((a) => a.fullName);

    // Lead schema counts
    const leadAgg = await Lead.aggregate([
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
                    { $eq: [{ $toLower: { $ifNull: ["$salesStatus", ""] } }, "on followup"] },
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

    // Customer schema counts
    const customerAgg = await Customer.aggregate([
      {
        $match: {
          leadDate: { $gte: orderStartDate, $lte: orderEndDate },
          assignedTo: { $in: salesAgentNames },
        },
      },
      {
        $group: {
          _id: "$assignedTo",
          leadsAssigned: { $sum: 1 },
          openLeads: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $in: ["$leadStatus", [
                      "New Lead",
                      "CONS Scheduled",
                      "CONS Done",
                      "Call Back Later",
                      "On Follow Up",
                      "CNP",
                      "Switch Off",
                    ]] },
                    { $eq: ["$leadStatus", null] },
                    { $eq: ["$leadStatus", ""] },
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

    const perAgentLeads = {};

    leadAgg.forEach((agent) => {
      perAgentLeads[agent._id] = {
        leadsAssigned: agent.leadsAssigned || 0,
        openLeads: agent.openLeads || 0,
      };
    });

    customerAgg.forEach((agent) => {
      if (!perAgentLeads[agent._id]) {
        perAgentLeads[agent._id] = { leadsAssigned: 0, openLeads: 0 };
      }
      perAgentLeads[agent._id].leadsAssigned += agent.leadsAssigned || 0;
      perAgentLeads[agent._id].openLeads += agent.openLeads || 0;
    });

    const leadsAssignedCount = Object.values(perAgentLeads).reduce(
      (sum, a) => sum + (a.leadsAssigned || 0),
      0
    );

    const openLeadsLeadAgg = await Lead.aggregate([
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

    const openLeadsCustomerAgg = await Customer.aggregate([
      {
        $match: {
          assignedTo: { $in: salesAgentNames },
          $or: [
            {
              leadStatus: {
                $in: [
                  "New Lead",
                  "CONS Scheduled",
                  "CONS Done",
                  "Call Back Later",
                  "On Follow Up",
                  "CNP",
                  "Switch Off",
                ],
              },
            },
            { leadStatus: null },
            { leadStatus: "" },
          ],
        },
      },
      { $count: "openLeads" },
    ]);

    const openLeadsCount =
      (openLeadsLeadAgg[0]?.openLeads || 0) +
      (openLeadsCustomerAgg[0]?.openLeads || 0);

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
            $first: { $ifNull: ["$totalPrice", "$amountPaid"] },
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

    const overallSalesDone = ordersAgg.reduce((sum, a) => sum + a.orderCount, 0);
    const overallTotalSales = ordersAgg.reduce((sum, a) => sum + a.orderSalesAmount, 0);
    const overallConversionRate =
      leadsAssignedCount > 0 ? (overallSalesDone / leadsAssignedCount) * 100 : 0;
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
    const salesAgents = await Employee.find(
      { role: "Sales Agent", status: "active" },
      "fullName"
    );
    const salesAgentNames = salesAgents.map((a) => a.fullName);
    const refDate =
      req.query.referenceDate || new Date().toISOString().split("T")[0];
    const today = refDate;

    function addDays(dateStr, days) {
      const d = new Date(dateStr);
      d.setDate(d.getDate() + days);
      return d.toISOString().split("T")[0];
    }

    const tomorrow = addDays(today, 1);
    const yesterday = addDays(today, -1);
    const dayAfterTomorrow = addDays(today, 2);

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

router.get("/lead-source-summary", async (req, res) => {
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

router.get("/all-shipment-summary", async (req, res) => {
  try {
    const { startDate, endDate, agentName } = req.query;
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "startDate and endDate are required (YYYY-MM-DD)" });
    }

    let agentFilter;
    if (agentName && agentName !== "All Agents") {
      agentFilter = agentName;
    } else {
      const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName");
      agentFilter = { $in: salesAgents.map((a) => a.fullName) };
    }

    const { s, e } = parseDateRange(startDate, endDate);

    const pipeline = [
      {
        $match: {
          orderDate: { $gte: s, $lte: e },
          agentName: agentFilter,
        },
      },
      {
        $addFields: {
          normOrderId: { $trim: { input: "$orderId", chars: "#" } },
        },
      },
      {
        $lookup: {
          from: "orders",
          localField: "normOrderId",
          foreignField: "order_id",
          as: "orderInfo",
        },
      },
      {
        $unwind: {
          path: "$orderInfo",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          amount: { $ifNull: ["$totalPrice", 0] },
          shipment_status: "$orderInfo.shipment_status",
        },
      },
      {
        $group: {
          _id: "$shipment_status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ];

    const agg = await MyOrder.aggregate(pipeline);

    const totalCount = agg.reduce((sum, doc) => sum + doc.count, 0);
    const result = agg.map((doc) => ({
      category: doc._id || "Not Provided",
      count: doc.count,
      amount: Number(doc.totalAmount.toFixed(2)),
      percentage:
        totalCount > 0 ? Number(((doc.count / totalCount) * 100).toFixed(2)) : 0,
    }));

    res.json(result);
  } catch (err) {
    console.error("Error fetching shipment summary:", err);
    res.status(500).json({
      message: "Error fetching shipment summary",
      error: err.message,
    });
  }
});

router.get("/cod-prepaid-summary", async (req, res) => {
  try {
    const { startDate, endDate, agentAssignedName } = req.query;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ message: "startDate and endDate are required" });
    }

    const sDate = new Date(startDate);
    const eDate = new Date(endDate);
    eDate.setHours(23, 59, 59, 999);

    const salesAgents = await Employee.find(
      { role: "Sales Agent", status: "active" },
      "fullName"
    );
    const agentNames = salesAgents.map((a) => a.fullName);

    let agentFilter = agentNames;
    if (agentAssignedName && agentAssignedName !== "All Agents") {
      agentFilter = [agentAssignedName];
    }

    const myOrderData = await MyOrder.find(
      {
        orderDate: { $gte: sDate, $lte: eDate },
        agentName: { $in: agentFilter },
      },
      "agentName paymentMethod partialPayment"
    ).lean();

    const leadData = await Lead.find(
      {
        lastOrderDate: { $gte: startDate, $lte: endDate },
        agentAssigned: { $in: agentFilter },
        salesStatus: "Sales Done",
      },
      "agentAssigned modeOfPayment partialPayment"
    ).lean();

    const combined = [];

    myOrderData.forEach((o) => {
      combined.push({
        agentName: o.agentName,
        method: (o.paymentMethod || "").toUpperCase(),
        isPartial: Number(o.partialPayment || 0) > 0,
      });
    });

    leadData.forEach((l) => {
      combined.push({
        agentName: l.agentAssigned,
        method: (l.modeOfPayment || "").toUpperCase(),
        isPartial: Number(l.partialPayment || 0) > 0,
      });
    });

    const results = agentFilter.map((agent) => {
      const rows = combined.filter((c) => c.agentName === agent);
      const totalOrders = rows.length;

      const partialOrders = rows.filter((r) => r.isPartial).length;
      const codOrders = rows.filter(
        (r) => !r.isPartial && r.method === "COD"
      ).length;
      const prepaidOrders = totalOrders - (partialOrders + codOrders);

      const getPct = (val) =>
        totalOrders > 0 ? Number(((val / totalOrders) * 100).toFixed(2)) : 0;

      return {
        agentName: agent,
        totalOrders,
        codOrders,
        prepaidOrders,
        partialOrders,
        codPercentage: getPct(codOrders),
        prepaidPercentage: getPct(prepaidOrders),
        partialPercentage: getPct(partialOrders),
      };
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ message: "Error", error: err.message });
  }
});

module.exports = router;