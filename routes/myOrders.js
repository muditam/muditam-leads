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
      dosageOrdered,
      selfRemark,
      paymentMethod,
      upsellAmount,
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
      !paymentMethod
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Convert values to the appropriate types
    const newOrder = new MyOrder({
      customerName,
      phone,
      shippingAddress,
      paymentStatus,
      productOrdered,
      orderDate: new Date(orderDate),
      orderId,
      totalPrice: Number(totalPrice),
      agentName,
      partialPayment: Number(partialPayment),
      dosageOrdered,
      selfRemark,
      paymentMethod,
      upsellAmount: upsellAmount ? Number(upsellAmount) : 0,
    });

    await newOrder.save();
    return res
      .status(201)
      .json({ message: "Order added to My Orders successfully", order: newOrder });
  } catch (error) {
    console.error("Error adding to My Orders:", error);
    return res.status(500).json({ error: "Failed to add order to My Orders" });
  }
});

router.get("/", async (req, res) => {
  try {
    const orders = await MyOrder.find({});
    res.json(orders);
  } catch (error) {
    console.error("Error fetching My Orders:", error);
    res.status(500).json({ error: "Failed to fetch My Orders" });
  }
});

module.exports = router;
