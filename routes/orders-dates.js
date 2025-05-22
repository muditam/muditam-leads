require("dotenv").config();
const express = require("express");
const axios = require("axios");
const router = express.Router();

const SHOPIFY_STORE_NAME = `${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const SHOPIFY_API_VERSION = "2023-07";
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

router.get("/api/shopify/orders-dates", async (req, res) => {
  const phoneNumber = req.query.phoneNumber;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Missing phoneNumber query param" });
  }

  const normalizedPhone = normalizePhone(phoneNumber);
  const lastDigits = normalizedPhone.slice(-10); // Use last 10 digits for partial match
  const headers = {
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    "Content-Type": "application/json",
  };

  try {
    const query = `phone:*${lastDigits}`;
    const customerSearchUrl = `https://${SHOPIFY_STORE_NAME}/admin/api/${SHOPIFY_API_VERSION}/customers/search.json?query=${query}`;
    const customerResponse = await axios.get(customerSearchUrl, { headers });

    const customers = customerResponse.data.customers || [];
    if (customers.length === 0) {
      return res.json({ firstOrderDate: null, lastOrderDate: null, totalSpend: 0, orders: [] });
    }

    const customer = customers.find((c) =>
      (c.phone || "").replace(/\D/g, "").endsWith(lastDigits)
    ) || customers[0];

    const ordersUrl = `https://${SHOPIFY_STORE_NAME}/admin/api/${SHOPIFY_API_VERSION}/orders.json?customer_id=${customer.id}&status=any&limit=250`;
    const ordersResponse = await axios.get(ordersUrl, { headers });

    const orders = ordersResponse.data.orders || [];

    if (orders.length === 0) {
      return res.json({ firstOrderDate: null, lastOrderDate: null, totalSpend: 0, orders: [] });
    }

    // Sort orders by creation date
    orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const firstOrderDate = orders[0].created_at;
    const lastOrderDate = orders[orders.length - 1].created_at;

    const totalSpend = orders.reduce((sum, order) => {
      const total = parseFloat(order.total_price) || 0;
      return sum + total;
    }, 0);

    return res.json({ firstOrderDate, lastOrderDate, totalSpend, orders });
  } catch (error) {
    console.error("Shopify orders-dates error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to fetch order data from Shopify." });
  }
});

module.exports = router;
