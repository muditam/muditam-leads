// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");

// GET /api/orders/by-order-ids?order_ids=1001,1002,1003
router.get("/by-order-ids", async (req, res) => {
  try {
    let { order_ids } = req.query;
    if (!order_ids) {
      return res.status(400).json({ error: "order_ids query param required" });
    }
    // Support both array and comma-separated string
    let idsArray = Array.isArray(order_ids)
      ? order_ids
      : order_ids.split(",").map((x) => x.trim());

    if (idsArray.length === 0) {
      return res.json([]);
    }

    // Query the orders
    const orders = await Order.find(
      { order_id: { $in: idsArray } },
      { order_id: 1, shipment_status: 1, _id: 0 }
    ).lean();

    // Return: [{ order_id: '1001', shipment_status: 'Delivered' }, ...]
    res.json(orders);
  } catch (err) {
    console.error("Error in /api/orders/by-order-ids:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
