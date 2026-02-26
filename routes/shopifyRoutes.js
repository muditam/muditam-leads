// routes/shopifyCustomer.js

const express = require("express");
const axios = require("axios");
const router = express.Router();

const Order = require("../models/Order");

const { SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN } = process.env;

const normalizePhone = (phoneStr = "") => phoneStr.replace(/\D/g, "");

// Accepts: "#ma119", "ma119", "MA119", " #MA119  "
const normalizeOrderName = (raw = "") => raw.trim().replace(/^#/, "").toUpperCase();

const shopifyHeaders = {
  "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
  "Content-Type": "application/json",
};

// Utilities to handle both "#MA119" and "MA119"
const nameVariants = (shopifyName = "") => {
  const trimmed = (shopifyName || "").trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  const noHash = trimmed.replace(/^#/, "");
  return [withHash, noHash];
};

// Try both REST filters that commonly work across stores:
async function fetchOrderByName(nameNoHash) {
  const base = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json`;

  // 1) Try exact name with '#'
  const byNameUrl = `${base}?status=any&name=${encodeURIComponent("#" + nameNoHash)}`;
  let resp = await axios.get(byNameUrl, { headers: shopifyHeaders });
  if (resp?.data?.orders?.length) return resp.data.orders[0];

  // 2) Fallback: use a query search by name (works on many stores)
  const queryUrl = `${base}?status=any&query=${encodeURIComponent(`name:${nameNoHash}`)}`;
  resp = await axios.get(queryUrl, { headers: shopifyHeaders });
  if (resp?.data?.orders?.length) {
    const exact = resp.data.orders.find(
      (o) => o.name && o.name.replace(/^#/, "").toUpperCase() === nameNoHash
    );
    return exact || resp.data.orders[0];
  }

  return null;
}

router.get("/customerDetails", async (req, res) => {
  try {
    const { phone, q } = req.query;
    const raw = (q || phone || "").trim();
    if (!raw) return res.status(400).json({ error: "Phone or query is required." });

    const digitsOnly = normalizePhone(raw);
    const hasLetters = /[A-Za-z]/.test(raw);
    const startsWithHash = raw.startsWith("#");

    const buildCustomerPayloadFromOrders = async (orders, customerId) => {
      orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const customerUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/customers/${customerId}.json`;
      const customerResp = await axios.get(customerUrl, { headers: shopifyHeaders });
      const c = customerResp.data.customer;

      const allIds = new Set();
      orders.forEach((o) => {
        const orderName = (o.name || "").trim();
        if (orderName) {
          const [withHash, noHash] = nameVariants(orderName);
          allIds.add(withHash);
          allIds.add(noHash);
        }
      });

      let internalOrders = [];
      if (allIds.size > 0) {
        internalOrders = await Order.find({ order_id: { $in: Array.from(allIds) } })
          .select("order_id shipment_status")
          .lean();
      }

      const shipmentMap = new Map();
      internalOrders.forEach((doc) => {
        const id = (doc.order_id || "").trim();
        if (!id) return;
        const withHash = id.startsWith("#") ? id : `#${id}`;
        const noHash = id.replace(/^#/, "");
        shipmentMap.set(withHash, doc.shipment_status);
        shipmentMap.set(noHash, doc.shipment_status);
      });

      const lastOrder = orders[0] || null;

      const orderDetails = orders.map((o) => {
        const orderName = (o.name || "").trim();
        const shipmentStatus =
          shipmentMap.get(orderName) || shipmentMap.get(orderName.replace(/^#/, "")) || null;

        return {
          id: o.id,
          name: orderName,
          created_at: o.created_at,
          totalAmount: o.total_price,
          itemCount: o.line_items.reduce((acc, it) => acc + Number(it.quantity || 0), 0),
          deliveryStatus: o.fulfillment_status || "Not fulfilled",
          shipmentStatus,
          shippingAddress: o.shipping_address
            ? `${o.shipping_address.address1 || ""}${
                o.shipping_address.address2 ? ", " + o.shipping_address.address2 : ""
              }, ${o.shipping_address.city || ""}, ${o.shipping_address.province || ""}, ${
                o.shipping_address.country || ""
              }, ${o.shipping_address.zip || ""}`
            : "Not available",
          lineItems: o.line_items.map((it) => ({
            title: it.title,
            variant: it.variant_title,
            amountPaid: `${it.price}`,
          })),
        };
      });

      return {
        customer: {
          id: c.id,
          name: `${c.first_name || ""} ${c.last_name || ""}`.trim(),
          totalOrders: orders.length,
          totalSpent: c.total_spent,
          lastOrderDate: lastOrder ? lastOrder.created_at : null,
          lastOrderPaymentStatus: lastOrder ? lastOrder.financial_status : null,
          orders: orderDetails,
        },
      };
    };

    const tryPhone = async () => {
      if (!digitsOnly) return null;
      if (digitsOnly.length < 8) return null;

      const customerUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${digitsOnly}`;
      const customerResponse = await axios.get(customerUrl, { headers: shopifyHeaders });
      const customers = customerResponse.data.customers || [];
      if (!customers.length) return null;

      const c = customers[0];
      const ordersUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?customer_id=${c.id}&status=any`;
      const ordersResp = await axios.get(ordersUrl, { headers: shopifyHeaders });
      const orders = ordersResp.data.orders || [];

      return buildCustomerPayloadFromOrders(orders, c.id);
    };

    const tryOrder = async () => {
      if (!(hasLetters || startsWithHash)) return null;

      const nameNoHash = normalizeOrderName(raw);
      const order = await fetchOrderByName(nameNoHash);
      if (!order || !order.customer?.id) return null;

      const customerId = order.customer.id;
      const ordersUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?customer_id=${customerId}&status=any`;
      const ordersResp = await axios.get(ordersUrl, { headers: shopifyHeaders });
      const orders = ordersResp.data.orders || [];

      return buildCustomerPayloadFromOrders(orders, customerId);
    };

    let payload = null;

    if (hasLetters || startsWithHash) {
      payload = await tryOrder();
      if (!payload) payload = await tryPhone();
    } else {
      payload = await tryPhone();
      if (!payload) payload = await tryOrder();
    }

    return res.json(payload || { customer: null });
  } catch (error) {
    console.error(
      "Error fetching Shopify customer details:",
      error?.response?.data || error.message
    );
    return res.status(500).json({ error: "Failed to fetch customer details from Shopify." });
  }
});

router.get("/order-details", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.status(400).json({ error: "orderId query parameter is required" });
  }

  try {
    const url = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders/${orderId}.json`;

    const response = await axios.get(url, { headers: shopifyHeaders });

    const order = response.data.order;
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // ✅ NEW: parse note_attributes for partial-paid info
    const noteAttrs = Array.isArray(order.note_attributes) ? order.note_attributes : [];
    const noteMap = {};
    for (const a of noteAttrs) {
      if (a?.name) noteMap[String(a.name)] = a?.value;
    }

    const paymentMode = noteMap.payment_mode || ""; // "Partial Paid" if you set it
    const partialPaidFromNote = noteMap.partial_paid_amount || "";
    const remainingFromNote = noteMap.remaining_cod_amount || "";
    const txnIdFromNote = noteMap.transaction_id || "";

    const orderDetails = {
      customerName: order.customer
        ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
        : "N/A",

      // ✅ Better phone fallback (shipping phone first)
      phone:
        order.shipping_address?.phone ||
        order.customer?.default_address?.phone ||
        "N/A",

      shippingAddress: order.shipping_address
        ? `${order.shipping_address.address1 || ""}${
            order.shipping_address.address2 ? ", " + order.shipping_address.address2 : ""
          }, ${order.shipping_address.city || ""}, ${order.shipping_address.province || ""}, ${
            order.shipping_address.country || ""
          }, ${order.shipping_address.zip || ""}`
        : "N/A",

      paymentStatus: order.financial_status, // can be "paid" | "pending" | "partially_paid" etc.
      productOrdered:
        order.line_items && order.line_items.length > 0
          ? order.line_items.map((item) => item.title).join(", ")
          : "N/A",
      orderDate: order.created_at,

      // keep same field names your popup expects
      orderId: order.name, // e.g. "#MA123"
      totalPrice: order.total_price,

      // ✅ NEW fields for Partial Paid UI
      paymentMode,
      transactionId: txnIdFromNote,
      partialPaidAmount: partialPaidFromNote ? Math.round(Number(partialPaidFromNote)) : "",
      remainingCODAmount: remainingFromNote,
    };

    return res.json(orderDetails);
  } catch (error) {
    console.error("Error fetching order details:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to fetch order details" });
  }
});

module.exports = router;