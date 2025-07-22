const express = require('express');
const axios = require('axios');
const router = express.Router();

const { SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN } = process.env; 

const normalizePhone = (phoneStr) => phoneStr.replace(/\D/g, '');

router.get('/customerDetails', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'Phone query parameter is required.' });
    }
    const normalizedPhone = normalizePhone(phone);

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
      totalAmount: order.total_price,
      itemCount: order.line_items.reduce((acc, item) => acc + Number(item.quantity || 0), 0),
      deliveryStatus: order.fulfillment_status || "Not fulfilled",
      shippingAddress: order.shipping_address
        ? `${order.shipping_address.address1 || ""}${order.shipping_address.address2 ? ", " + order.shipping_address.address2 : ""}, ${order.shipping_address.city || ""}, ${order.shipping_address.province || ""}, ${order.shipping_address.country || ""}, ${order.shipping_address.zip || ""}`
        : "Not available",
      lineItems: order.line_items.map(item => ({
        title: item.title,
        variant: item.variant_title,
        amountPaid: `${item.price}`,  
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

router.get("/order-details", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).json({ error: "orderId query parameter is required" });
  }
  
  try {
    const shopifyStore = process.env.SHOPIFY_STORE_NAME;
    const accessToken = process.env.SHOPIFY_API_SECRET;
    // Use Shopify’s API to fetch a single order by its ID.
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders/${orderId}.json`;
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    const order = response.data.order;
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    // Extract and format the fields expected by the frontend:
    const orderDetails = {
      customerName: order.customer
        ? `${order.customer.first_name} ${order.customer.last_name}`.trim()
        : "N/A",
      phone:
        order.customer && order.customer.default_address
          ? order.customer.default_address.phone
          : "N/A",
          shippingAddress: order.shipping_address
          ? `${order.shipping_address.address1}${order.shipping_address.address2 ? ", " + order.shipping_address.address2 : ""}, ${order.shipping_address.city}, ${order.shipping_address.province}, ${order.shipping_address.country}, ${order.shipping_address.zip}`
          : "N/A",        
      paymentStatus: order.financial_status,
      productOrdered: order.line_items && order.line_items.length > 0
        ? order.line_items.map(item => item.title).join(", ")
        : "N/A",
      orderDate: order.created_at,
      orderId: order.name,
      totalPrice: order.total_price,
    };

    return res.json(orderDetails);
  } catch (error) {
    console.error("Error fetching order details:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to fetch order details" });
  }
});


module.exports = router;
