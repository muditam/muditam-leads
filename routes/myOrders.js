const express = require("express");
const router = express.Router();
const MyOrder = require("../models/MyOrder");

router.post("/", async (req, res) => {
  try {
    const {
      customerName,
      phone,
      shippingAddress,
      paymentStatus,
      productOrdered,
      orderDate,
      orderId,
      totalPrice,
      agentName,
      partialPayment,
      dosageOrdered,  // NEW field
      selfRemark,     // NEW field
      paymentMethod,  // NEW field
      upsellAmount,   // NEW field
    } = req.body;

    // Validate required fields
    if (
      !customerName ||
      !phone ||
      !shippingAddress ||
      !paymentStatus ||
      !productOrdered ||
      !orderDate ||
      !orderId ||
      !totalPrice ||
      !agentName ||
      partialPayment == null ||
      !dosageOrdered ||
      !paymentMethod // Ensure paymentMethod is provided
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const newOrder = new MyOrder({
      customerName,
      phone,
      shippingAddress,
      paymentStatus,
      productOrdered,
      orderDate,
      orderId,
      totalPrice,
      agentName,
      partialPayment,
      dosageOrdered,  // NEW
      selfRemark,     // NEW (optional)
      paymentMethod,  // NEW
      upsellAmount,   // NEW
    });

    await newOrder.save();
    return res.status(201).json({ message: "Order added to My Orders successfully", order: newOrder });
  } catch (error) {
    console.error("Error adding to My Orders:", error);
    return res.status(500).json({ error: "Failed to add order to My Orders" });
  }
});

module.exports = router;
