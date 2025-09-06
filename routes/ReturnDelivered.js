// routes/rtoDelivered.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder");

// GET /api/rto-delivered?statusGroup=all&page=1&limit=50
// Also supports: &statuses=RTO%20Delivered,RTO%20Initiated
router.get("/rto-delivered", async (req, res) => {
  try {
    const agentNameHeader = req.header("x-agent-name");
    const agentNameQuery = req.query.agentName;
    const agentName = (agentNameHeader || agentNameQuery || "").trim();
    if (!agentName) return res.status(400).json({ error: "Agent name is required" });

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "50", 10), 1);
    const skip = (page - 1) * limit;

    // NEW: flexible status filtering
    const statusGroup = (req.query.statusGroup || "all").toLowerCase();
    const statusesCsv = (req.query.statuses || "").trim();
    const explicitStatuses = statusesCsv
      ? statusesCsv.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const agentNameLower = agentName.toLowerCase();

    const pipeline = [
      // 1) Only this agent's MyOrders (case-insensitive)
      { $match: { $expr: { $eq: [{ $toLower: "$agentName" }, agentNameLower] } } },

      // 2) Prepare join key (strip '#'), keep useful fields
      {
        $project: {
          _id: 0,
          agentName: 1,
          customerName: 1,
          phone: 1,
          shippingAddress: 1,
          paymentStatus: 1,
          productOrdered: 1,
          totalPrice: 1,
          partialPayment: 1,
          paymentMethod: 1,
          upsellAmount: 1,
          orderIdStripped: { $replaceAll: { input: "$orderId", find: "#", replacement: "" } },
          orderIdWithHash: "$orderId",
        },
      },

      // 3) Join Orders by order_id (no status filter here)
      {
        $lookup: {
          from: "orders",
          let: { oid: "$orderIdStripped" },
          pipeline: [
            { $match: { $expr: { $eq: ["$order_id", "$$oid"] } } },
            {
              $project: {
                _id: 0,
                order_id: 1,
                shipment_status: 1,
                order_date: 1,
                tracking_number: 1,
                carrier_title: 1,
              },
            },
          ],
          as: "ord",
        },
      },
      { $unwind: "$ord" },

      // 4) NEW: filter by status group / explicit statuses
      {
        $match: (function buildStatusMatch() {
          if (explicitStatuses && explicitStatuses.length) {
            // Exact match to any of the provided statuses
            return { "ord.shipment_status": { $in: explicitStatuses } };
          }
          if (statusGroup === "delivered") {
            return { "ord.shipment_status": "RTO Delivered" };
          }
          if (statusGroup === "non_delivered") {
            // Starts with RTO but NOT 'RTO Delivered'
            return {
              $expr: {
                $and: [
                  { $regexMatch: { input: "$ord.shipment_status", regex: /^RTO/i } },
                  { $not: { $regexMatch: { input: "$ord.shipment_status", regex: /^RTO\s+Delivered$/i } } },
                ],
              },
            };
          }
          // 'all' (default): any status starting with RTO (includes RTO Delivered)
          return { $expr: { $regexMatch: { input: "$ord.shipment_status", regex: /^RTO/i } } };
        })(),
      },

      // 5) Final shape
      {
        $project: {
          orderId: "$orderIdWithHash",
          order_id: "$ord.order_id",
          shipment_status: "$ord.shipment_status",
          order_date: "$ord.order_date",
          tracking_number: "$ord.tracking_number",
          carrier_title: "$ord.carrier_title",
          customerName: 1,
          phone: 1,
          shippingAddress: 1,
          paymentStatus: 1,
          productOrdered: 1,
          totalPrice: 1,
          partialPayment: 1,
          paymentMethod: 1,
          upsellAmount: 1,
          agentName: 1,
        },
      },

      { $sort: { order_date: -1, order_id: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          meta: [{ $count: "total" }],
        },
      },
    ];

    const result = await MyOrder.aggregate(pipeline, { allowDiskUse: true });
    const data = result?.[0]?.data || [];
    const total = result?.[0]?.meta?.[0]?.total || 0;

    res.json({ page, limit, total, data });
  } catch (err) {
    console.error("Error fetching RTO orders:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
