// routes/rtoDelivered.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder"); // note plural filename

// GET /api/rto-delivered?status=RTO%20Delivered&page=1&limit=50
router.get("/rto-delivered", async (req, res) => {
  try {
    const agentNameHeader = req.header("x-agent-name");
    const agentNameQuery = req.query.agentName;
    const agentName = (agentNameHeader || agentNameQuery || "").trim();
    if (!agentName) return res.status(400).json({ error: "Agent name is required" });

    const status = (req.query.status || "RTO Delivered").trim();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "50", 10), 1);
    const skip = (page - 1) * limit;

    const agentNameLower = agentName.toLowerCase();

    // Start from MyOrders (filtered by agent) -> join Orders
    const pipeline = [
      // 1) Only this agent's orders (case-insensitive)
      {
        $match: {
          $expr: { $eq: [{ $toLower: "$agentName" }, agentNameLower] },
        },
      },
      // 2) Prepare join key (strip '#'), and keep just fields we need
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
          // strip '#' from MyOrder.orderId for join
          orderIdStripped: {
            $replaceAll: { input: "$orderId", find: "#", replacement: "" },
          },
          orderIdWithHash: "$orderId", // preserve original with '#'
        },
      },
      // 3) Join to Orders by order_id, and keep only required status
      {
        $lookup: {
          from: "orders",
          let: { oid: "$orderIdStripped", wantStatus: status },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$order_id", "$$oid"] },
                    { $eq: ["$shipment_status", "$$wantStatus"] },
                  ],
                },
              },
            },
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
      { $unwind: "$ord" }, // keep only matching rows
      // 4) Final shape
      {
        $project: {
          orderId: "$orderIdWithHash", // already with '#'
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

    // allowDiskUse helps with big sorts
    const result = await MyOrder.aggregate(pipeline, { allowDiskUse: true });
    const data = result?.[0]?.data || [];
    const total = result?.[0]?.meta?.[0]?.total || 0;

    res.json({ page, limit, total, data });
  } catch (err) {
    console.error("Error fetching RTO Delivered orders:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
