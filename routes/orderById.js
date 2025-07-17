// routes/orderById.js
const express = require("express");
const router = express.Router(); 
const Order = require("../models/Order");

router.get("/", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).json({ message: "Missing orderId" }); 
  }
  try { 
    const orderRecord = await Order.findOne({ order_id: orderId }).lean(); 
    if (orderRecord) {
      return res.status(200).json(orderRecord);
    } else {
      return res.status(404).json({ message: "Order not found" });
    }
  } catch (error) {
    console.error("Error fetching order:", error);
    return res.status(500).json({ message: "Error fetching order", error: error.message }); 
  }
});

module.exports = router;
