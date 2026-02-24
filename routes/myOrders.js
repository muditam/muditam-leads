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
      transactionId,
    } = req.body;

    // ✅ Validate required fields (partialPayment NOT required for all)
    if (
      !customerName ||
      !phone ||
      !shippingAddress ||
      !paymentStatus ||
      !productOrdered ||
      !orderDate ||
      !orderId ||
      totalPrice == null || // allow 0 check safely
      !agentName ||
      !dosageOrdered ||
      !paymentMethod
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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

      // ✅ Default partialPayment to 0
      partialPayment: Number(partialPayment || 0),

      dosageOrdered,
      selfRemark,
      paymentMethod,
      upsellAmount: upsellAmount ? Number(upsellAmount) : 0,
      transactionId: transactionId || "",
    });

    await newOrder.save();

    return res.status(201).json({
      message: "Order added to My Orders successfully",
      order: newOrder,
    });
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