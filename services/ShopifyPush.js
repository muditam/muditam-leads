const express = require("express");
const axios = require("axios");
const router = express.Router();

// POST /create-order endpoint
router.post("/create-order", async (req, res) => {
  const {
    cartItems,
    shippingAddress,
    billingAddress,
    paymentStatus,
    transactionId,
    customerId,
    shippingCost,
    appliedDiscount,
  } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
 
  const orderPayload = {
    order: {
      line_items: cartItems.map(item => ({
        variant_id: item.variantId,
        quantity: item.quantity,
      })),
      shipping_address: {
        first_name: shippingAddress.firstName,
        last_name: shippingAddress.lastName,
        address1: shippingAddress.address1,
        address2: shippingAddress.address2,
        city: shippingAddress.city,
        province: shippingAddress.province,
        country: shippingAddress.country,
        zip: shippingAddress.zip,
        phone: shippingAddress.phone,  
      },
      billing_address: {
        first_name: billingAddress.firstName,
        last_name: billingAddress.lastName,
        address1: billingAddress.address1,
        address2: billingAddress.address2,
        city: billingAddress.city,
        province: billingAddress.province,
        country: billingAddress.country,
        zip: billingAddress.zip,
      },
      shipping_lines: [],
      discount_codes: [],
      financial_status: paymentStatus === "COD" ? "pending" : "paid",
      note_attributes: transactionId
        ? [{ name: "transaction_id", value: transactionId }]
        : [],
    }
  };

  // Add shipping line if shippingCost is provided and greater than 0
  if (shippingCost && parseFloat(shippingCost) > 0) {
    orderPayload.order.shipping_lines.push({
      title: "Shipping Charges",
      price: parseFloat(shippingCost).toFixed(2),
      code: "SHIPPING",
    });
  }

  // Add discount code if appliedDiscount is provided and greater than 0
  if (appliedDiscount && parseFloat(appliedDiscount) > 0) {
    orderPayload.order.discount_codes.push({
      code: "APPLIED_DISCOUNT",
      amount: parseFloat(appliedDiscount).toFixed(2),
      type: "fixed_amount",
    });
  }
 
  if (customerId) {
    orderPayload.order.customer = { id: customerId };
  }

  const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders.json`;
  try {
    const response = await axios.post(url, orderPayload, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    res.status(201).json({
      message: "Order created successfully",
      order: response.data.order,
    });
  } catch (error) {
    console.error("Error creating order:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error creating order",
      error: error.response?.data || error.message,
    });
  }
});

// GET /customer endpoint to search for an existing customer by phone
router.get("/customer", async (req, res) => {
  const { phone } = req.query;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
  const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${phone}`;

  try {
    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    const customers = response.data.customers;
    // Return the first customer if found
    res.json(customers && customers.length > 0 ? customers[0] : {});
  } catch (error) {
    console.error("Error fetching customer:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error fetching customer",
      error: error.response?.data || error.message,
    });
  }
});

// POST /create-customer endpoint to create a new customer on Shopify
router.post("/create-customer", async (req, res) => {
  const { phone, first_name, last_name } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
  const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers.json`;
  const payload = {
    customer: {
      first_name,
      last_name,
      phone,
    }
  };
  try {
    const response = await axios.post(url, payload, {
       headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
       },
    });
    res.status(201).json({
       message: "Customer created successfully",
       customer: response.data.customer,
    });
  } catch (error) {
    console.error("Error creating customer:", error.response?.data || error.message);
    res.status(500).json({
       message: "Error creating customer",
       error: error.response?.data || error.message,
    });
  }
});
 
router.get("/customer-orders", async (req, res) => { 
  res.json({ addresses: [] });
});
 
router.post("/update-order-note", async (req, res) => {
  const { orderId, note } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
  const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders/${orderId}.json`;
  
  try {
    const response = await axios.put(
      url,
      {
        order: {
          id: orderId,
          note: note,
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    res.status(200).json({
      message: "Order note updated successfully",
      order: response.data.order,
    });
  } catch (error) {
    console.error(
      "Error updating order note:",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Error updating order note",
      error: error.response?.data || error.message,
    });
  }
});

// In your Express routes file
router.put("/customer-address", async (req, res) => {
  const {
    customerId,
    addressId,
    first_name,
    last_name,
    phone,
    address1,
    address2,
    city,
    province,
    country,
    zip,
  } = req.body;

  try {
    const shopifyStore = process.env.SHOPIFY_STORE_NAME;
    const accessToken = process.env.SHOPIFY_API_SECRET;
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${customerId}/addresses/${addressId}.json`;

    const payload = {
      address: {
        id: addressId,
        first_name,
        last_name,
        phone,
        address1,
        address2,
        city,
        province,
        country,
        zip,
      },
    };

    const response = await axios.put(url, payload, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    res.status(200).json({
      message: "Address updated successfully",
      address: response.data.customer_address,
    });
  } catch (error) {
    console.error("Error updating customer address:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error updating customer address",
      error: error.response?.data || error.message,
    });
  }
});


module.exports = router;
