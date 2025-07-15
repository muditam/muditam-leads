const express = require("express");
const router = express.Router();
const Order = require("../models/Order");

// Normalize input to strip unwanted characters and lowercase
const normalize = (value) => {
  return value
    .replace(/#/g, "") // remove hash
    .replace(/^(\+91|91)/, "") // remove +91 or 91 prefix
    .trim()
    .toLowerCase();
};

// Determine if input is a contact number
const isPhoneNumber = (value) => /^[6-9]\d{9}$/.test(value);

// Determine if input is an order ID
const isOrderId = (value) => /^ma\d+$/i.test(value) || /^\d+$/.test(value);

// GET /api/delivery/status?query=...
router.get("/status", async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter." });
  }

  const input = normalize(query);

  try {
    if (isPhoneNumber(input)) {
      // Search by contact number — return all matching orders
      const orders = await Order.find({
        contact_number: input,
      }).sort({ createdAt: -1 });

      if (!orders.length) {
        return res.status(404).json([]);
      }

      return res.json(
        orders.map((order) => ({
          order_id: order.order_id,
          shipment_status: order.shipment_status,
          order_date: order.order_date,
          tracking_number: order.tracking_number, // Include tracking_number
        }))
      );
    } else if (isOrderId(input)) {
      // Search by order ID
      const order = await Order.findOne({
        order_id: input.toUpperCase(),
      });

      if (!order) {
        return res.status(404).json([]);
      }

      return res.json([
        {
          order_id: order.order_id,
          shipment_status: order.shipment_status,
          order_date: order.order_date,
          tracking_number: order.tracking_number, // Include tracking_number
        },
      ]);
    } else {
      return res.status(400).json({ error: "Invalid input format." }); 
    }
  } catch (err) {
    console.error("Error in delivery status check:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
