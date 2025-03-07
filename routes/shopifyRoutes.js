// routes/shopifyRoutes.js

const express = require('express');
const axios = require('axios');
const router = express.Router();

const { SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN } = process.env;

// Utility: Remove all non-digit characters from a phone string.
const normalizePhone = (phoneStr) => phoneStr.replace(/\D/g, '');

/**
 * GET /api/shopify/customerDetails?phone=...
 *
 * Searches for a customer in Shopify based on a normalized phone number.
 * If found, it fetches all orders for that customer, then aggregates:
 *  - Total orders placed.
 *  - Total spent (from customer record).
 *  - Last order date & time.
 *  - Last order payment status.
 *  - Detailed list of orders, where each order includes:
 *      - Created date & time.
 *      - Total item count.
 *      - Delivery (fulfillment) status.
 *      - For each line item: product title, variant, and amount paid.
 */
router.get('/customerDetails', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'Phone query parameter is required.' });
    }
    const normalizedPhone = normalizePhone(phone);

    // 1. Search for the customer using Shopify's customers search endpoint.
    const customerUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-04/customers/search.json?query=phone:${normalizedPhone}`;
    const headers = {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    };
    const customerResponse = await axios.get(customerUrl, { headers });
    const customers = customerResponse.data.customers || [];
    if (customers.length === 0) {
      return res.json({ customer: null });
    }
    // Assume the first customer is the one we're interested in.
    const customer = customers[0];

    // 2. Fetch orders for this customer.
    // Shopify supports filtering orders by customer_id.
    const ordersUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-04/orders.json?customer_id=${customer.id}&status=any`;
    const ordersResponse = await axios.get(ordersUrl, { headers });
    const orders = ordersResponse.data.orders || [];

    // Sort orders by creation date (most recent first)
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 3. Aggregate customer data.
    const totalOrders = orders.length;
    const totalSpent = customer.total_spent; // from the customer object
    const lastOrder = orders[0] || null;
    const lastOrderDate = lastOrder ? lastOrder.created_at : null;
    const lastOrderPaymentStatus = lastOrder ? lastOrder.financial_status : null;

    // 4. Map order details.
    const orderDetails = orders.map(order => ({
      id: order.id,
      created_at: order.created_at,
      itemCount: order.line_items.reduce((acc, item) => acc + Number(item.quantity || 0), 0),
      deliveryStatus: order.fulfillment_status || "Not fulfilled",
      lineItems: order.line_items.map(item => ({
        title: item.title,
        variant: item.variant_title,
        amountPaid: item.price, // Adjust if needed for correct amount paid
      })),
    }));

    return res.json({
      customer: {
        id: customer.id,
        name: `${customer.first_name || ""} ${customer.last_name || ""}`.trim(),
        totalOrders,
        totalSpent,
        lastOrderDate,
        lastOrderPaymentStatus,
        orders: orderDetails,
      },
    });
  } catch (error) {
    console.error(
      'Error fetching Shopify customer details:',
      error?.response?.data || error.message
    );
    return res.status(500).json({ error: 'Failed to fetch customer details from Shopify.' });
  }
});

module.exports = router;
