const express = require("express");
const axios = require("axios");
const router = express.Router();

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// POST /create-order endpoint
router.post("/create-order", async (req, res) => {
  const {
    cartItems,
    shippingAddress,
    billingAddress, 
    paymentStatus,  
 
    paymentMode, 
    partialPaidAmount,
    orderTotal,

    transactionId,
    customerId,
    shippingCost,
    appliedDiscount,
  } = req.body;

  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
 
  const mode = String(paymentMode || "").trim();
  const isPartial = mode === "Partial Paid";
  const isCOD = mode === "COD" || (!mode && paymentStatus === "COD");
  const isPrepaid = mode === "Prepaid" || (!mode && paymentStatus !== "COD");
 
  if (isPartial) {
    const paid = toNumber(partialPaidAmount);
    const total = toNumber(orderTotal);

    if (!paid || paid <= 0) {
      return res
        .status(400)
        .json({ message: "partialPaidAmount is required and must be > 0" });
    }
    if (!total || total <= 0) {
      return res
        .status(400)
        .json({ message: "orderTotal is required and must be > 0 for Partial Paid" });
    }
    if (paid >= total) {
      return res
        .status(400)
        .json({ message: "partialPaidAmount must be less than orderTotal" });
    }
    if (!transactionId || String(transactionId).trim() === "") {
      return res
        .status(400)
        .json({ message: "transactionId is required for Partial Paid" });
    }
  }

  const orderPayload = {
    order: {
      line_items: (cartItems || []).map((item) => ({
        variant_id: item.variantId,
        quantity: item.quantity,
      })),
      shipping_address: {
        first_name: shippingAddress?.firstName,
        last_name: shippingAddress?.lastName,
        address1: shippingAddress?.address1,
        address2: shippingAddress?.address2,
        city: shippingAddress?.city,
        province: shippingAddress?.province,
        country: shippingAddress?.country,
        zip: shippingAddress?.zip,
        phone: shippingAddress?.phone,
      },
      billing_address: {
        first_name: billingAddress?.firstName,
        last_name: billingAddress?.lastName,
        address1: billingAddress?.address1,
        address2: billingAddress?.address2,
        city: billingAddress?.city,
        province: billingAddress?.province,
        country: billingAddress?.country,
        zip: billingAddress?.zip,
      },
      shipping_lines: [],
      discount_codes: [],
 
      financial_status: isPrepaid ? "paid" : "pending",

      note_attributes: [],
      tags: isPartial ? "PARTIAL_COD" : isCOD ? "COD" : "PREPAID",
    },
  };
 
  if (transactionId) {
    orderPayload.order.note_attributes.push({
      name: "transaction_id",
      value: String(transactionId),
    });
  }

  if (isPartial) {
    const paid = toNumber(partialPaidAmount);
    const total = toNumber(orderTotal);
    const remaining = Math.max(0, total - paid);

    orderPayload.order.note_attributes.push(
      { name: "payment_mode", value: "Partial Paid" },
      { name: "partial_paid_amount", value: paid.toFixed(2) },
      { name: "remaining_cod_amount", value: remaining.toFixed(2) }
    );
  }
 
  if (shippingCost && toNumber(shippingCost) > 0) {
    orderPayload.order.shipping_lines.push({
      title: "Shipping Charges",
      price: toNumber(shippingCost).toFixed(2),
      code: "SHIPPING",
    });
  }
 
  if (appliedDiscount && toNumber(appliedDiscount) > 0) {
    orderPayload.order.discount_codes.push({
      code: "APPLIED_DISCOUNT",
      amount: toNumber(appliedDiscount).toFixed(2),
      type: "fixed_amount",
    });
  }

  if (customerId) {
    orderPayload.order.customer = { id: customerId };
  }

  const createOrderUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders.json`;

  try {
    // 1) Create order
    const response = await axios.post(createOrderUrl, orderPayload, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const createdOrder = response.data.order;

    // 2) If Partial Paid -> create external sale transaction
    if (isPartial) {
      const paid = toNumber(partialPaidAmount);

      // ✅ CRITICAL FIX: source=external (otherwise Shopify rejects "sale")
      const txUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders/${createdOrder.id}/transactions.json?source=external`;

      const txPayload = {
        transaction: {
          kind: "sale",
          status: "success",
          amount: paid.toFixed(2),
          currency: createdOrder?.currency || "INR",
          gateway: "manual",
          source: "external", // extra-safe
          authorization: String(transactionId || ""),
        },
      };

      await axios.post(txUrl, txPayload, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      // 3) Fetch updated order so UI gets "partially_paid"
      const getUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders/${createdOrder.id}.json`;
      const updated = await axios.get(getUrl, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      return res.status(201).json({
        message: "Order created successfully (Partial Paid)",
        order: updated.data.order,
      });
    }

    // Prepaid/COD
    return res.status(201).json({
      message: "Order created successfully",
      order: createdOrder,
    });
  } catch (error) {
    console.error("Error creating order:", error.response?.data || error.message);
    return res.status(500).json({
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

  if (!phone || !String(first_name || "").trim() || !String(last_name || "").trim()) {
    return res.status(400).json({
      message: "phone, first_name and last_name are required",
    });
  }

  try {
    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    };
    const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
      phone
    )}`;
    const existingResponse = await axios.get(searchUrl, { headers });
    const existingCustomer = existingResponse.data.customers?.[0];

    if (existingCustomer?.id) {
      const updateUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${existingCustomer.id}.json`;
      const updatePayload = {
        customer: {
          id: existingCustomer.id,
          first_name,
          last_name,
          phone,
        },
      };
      const updatedResponse = await axios.put(updateUrl, updatePayload, {
        headers,
      });

      return res.status(200).json({
        message: "Customer updated successfully",
        customer: updatedResponse.data.customer,
      });
    }

    const createUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers.json`;
    const createPayload = {
      customer: {
        first_name,
        last_name,
        phone,
      },
    };
    const response = await axios.post(createUrl, createPayload, {
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
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.errors
        ? "Unable to save customer on Shopify"
        : "Error creating customer",
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
      { order: { id: orderId, note } },
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
    console.error("Error updating order note:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error updating order note",
      error: error.response?.data || error.message,
    });
  }
});

// PUT /customer-address
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
