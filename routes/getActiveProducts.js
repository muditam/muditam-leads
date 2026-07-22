require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Razorpay = require("razorpay");

const router = express.Router();

// Shopify
const SHOPIFY_STORE = `${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Razorpay
const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

// 🔹 Get Active Products
router.get("/api/shopify/active-products", async (req, res) => {
  try {
    const shopifyURL = `https://${SHOPIFY_STORE}/admin/api/2023-10/products.json`;

    const response = await axios.get(shopifyURL, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      params: {
        status: "active",
        limit: 250,
      },
    });

    const products = response.data.products.map((product) => ({
      id: product.id,
      title: product.title,
      image: product.image?.src || null,
      variants: product.variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        price: variant.price,
        inventory_quantity: variant.inventory_quantity,
      })),
    }));

    res.json(products);
  } catch (error) {
    console.error("Error fetching products:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch Shopify products" });
  }
});


// 🔹 Get Shopify Customer by Phone and all address fields
router.get("/api/shopify/customers", async (req, res) => {
  let phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }
  const digits = phone.replace(/\D/g, "");
  const normalizedOptions = [
    `+91${digits}`,
    `91${digits}`,
    digits.length === 10 ? digits : digits.slice(-10)
  ];

  let foundCustomer = null;
  let candidates = [];
  let searchQueries = [
    normalizedOptions[0],
    normalizedOptions[1],
    normalizedOptions[2],
  ];

  for (const query of searchQueries) {
    try {
      const url = `https://${SHOPIFY_STORE}/admin/api/2023-10/customers/search.json?query=${encodeURIComponent(query)}`;
      const response = await axios.get(url, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      });
      candidates = response.data.customers;
      foundCustomer = candidates.find(c => {
        const cDigits = (c.phone || "").replace(/\D/g, "");
        if (cDigits.slice(-10) === digits.slice(-10)) return true;
        if (c.addresses && c.addresses.length > 0) {
          return c.addresses.some(addr => {
            const aDigits = (addr.phone || "").replace(/\D/g, "");
            return aDigits.slice(-10) === digits.slice(-10);
          });
        }
        return false;
      });
      if (foundCustomer) break;
    } catch (err) {}
  }

  if (!foundCustomer) {
    return res.json({ addresses: [] });
  }

  // Send full address fields for each address
  const addresses = (foundCustomer.addresses || []).map(addr => ({
    id: addr.id,
    address1: addr.address1 || "",
    address2: addr.address2 || "",
    city: addr.city || "",
    province: addr.province || "",
    zip: addr.zip || "",
    country: addr.country || "",
    phone: addr.phone || "",
    name: addr.name || "",
    formatted: [
      addr.address1,
      addr.address2,
      addr.city,
      addr.province,
      addr.zip,
      addr.country,
    ].filter(Boolean).join(", "),
  }));

  res.json({ id: foundCustomer.id, addresses })
});


// 🔹 Razorpay Payment Link
router.post("/api/razorpay/generate-link", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: "Razorpay is not configured" });
    }
    const { customerName, customerPhone, customerAddress, amount } = req.body;
    if (!customerName || !customerPhone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const response = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      accept_partial: false,
      description: `Payment link for ${customerName}`,
      customer: {
        name: customerName,
        contact: customerPhone.replace(/\D/g, ""),
        email: undefined,
      },
      notify: { sms: true, email: false },
      reminder_enable: true,
      notes: {
        address: (typeof customerAddress === 'object' && customerAddress.formatted)
          ? customerAddress.formatted
          : (customerAddress || ""),
      },
      callback_url: "",
      callback_method: "get",
    });
    res.json({ paymentLink: response.short_url });
  } catch (error) {
    console.error("Razorpay Link Error:", error);
    res.status(500).json({ error: "Failed to generate payment link" });
  }
});


// 🔹 Shopify Place Order
router.post("/api/shopify/place-order", async (req, res) => {
  try {
    const {
      customer,
      cartItems,
      paymentMethod,
      transactionId,
      partialPaidAmount,
      orderTotal,
      shippingCharge,
      discount,
      discountType,
    } = req.body;

    if (!customer || !cartItems || cartItems.length === 0 || !customer.address) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // Build line items
    const line_items = cartItems.map((item) => ({
      variant_id: item.id,
      quantity: item.quantity,
      price: item.price,
      title: item.productTitle,
    }));

    // Use existing customer ID if present
    let shopifyCustomer;
    if (customer.customerId) {
      shopifyCustomer = { id: customer.customerId };
    } else {
      shopifyCustomer = {
        first_name: customer.name || "",
        phone: customer.phone || "",
        email: customer.email || "dummy@email.com",
      };
    }

    // Use the full address object if available, else parse string
    let shipping_address = (typeof customer.address === 'object' && customer.address.address1)
      ? customer.address
      : parseAddressString(customer.address);
    let billing_address = shipping_address;

    const lineItemsTotal = line_items.reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
      0
    );
    const calculatedOrderTotal =
      lineItemsTotal + Number(shippingCharge || 0) - Number(discount || 0);
    const safeOrderTotal = Number(orderTotal || calculatedOrderTotal || 0);
    const safePartialPaidAmount = Number(partialPaidAmount || 0);
    const isPrepaid = paymentMethod === "Prepaid";
    const isPartialPaid = paymentMethod === "Partial Paid";

    const note_attributes = [];
    if ((isPrepaid || isPartialPaid) && transactionId) {
      note_attributes.push({
        name: "transaction_id",
        value: transactionId
      });
    }

    if (isPartialPaid) {
      if (!(safePartialPaidAmount > 0)) {
        return res.status(400).json({ error: "partialPaidAmount is required for Partial Paid orders" });
      }
      if (!(safeOrderTotal > 0) || safePartialPaidAmount >= safeOrderTotal) {
        return res.status(400).json({ error: "partialPaidAmount must be less than the order total" });
      }
      if (!String(transactionId || "").trim()) {
        return res.status(400).json({ error: "transactionId is required for Partial Paid orders" });
      }

      note_attributes.push(
        { name: "payment_mode", value: "Partial Paid" },
        { name: "partial_paid_amount", value: String(safePartialPaidAmount.toFixed(2)) },
        {
          name: "remaining_cod_amount",
          value: String(Math.max(0, safeOrderTotal - safePartialPaidAmount).toFixed(2)),
        }
      );
    } else if (isPrepaid) {
      note_attributes.push({
        name: "payment_mode",
        value: "Prepaid",
      });
    } else {
      note_attributes.push({
        name: "payment_mode",
        value: "COD",
      });
    }

    const orderData = {
      order: {
        line_items,
        customer: shopifyCustomer,
        shipping_address,
        billing_address,
        financial_status: isPrepaid ? "paid" : "pending",
        note: "", // Blank, can be set after order placement
        note_attributes,
        discount_codes: discount
          ? [
              {
                code: "ManualDiscount",
                amount: String(discount),
                type: discountType === "percentage" ? "percentage" : "fixed_amount",
              },
            ]
          : [],
        shipping_lines: shippingCharge
          ? [
              {
                title: "Manual Shipping",
                price: String(shippingCharge),
                code: "MANUAL_SHIPPING",
              },
            ]
          : [],
        transactions:
          isPrepaid && transactionId
            ? [
                {
                  kind: "sale",
                  status: "success",
                  amount: String(
                    safeOrderTotal
                  ),
                  gateway: "razorpay",
                  authorization: transactionId,
                },
              ]
            : [],
      },
    };

    const response = await axios.post(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
      orderData,
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    if (isPartialPaid && transactionId) {
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${response.data.order.id}/transactions.json?source=external`,
        {
          transaction: {
            kind: "sale",
            status: "success",
            amount: String(safePartialPaidAmount.toFixed(2)),
            currency: response.data.order?.currency || "INR",
            gateway: "manual",
            source: "external",
            authorization: transactionId,
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
    }

    res.json({ success: true, shopifyOrder: response.data.order });
  } catch (error) {
    console.error("Shopify Place Order Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to place order" });
  }
});


// Address parsing fallback
function parseAddressString(formatted) {
  if (!formatted) return { address1: "No Address Provided", country: "India" };
  const parts = formatted.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    address1: parts[0] || formatted,
    address2: parts[1] || "",
    city: parts[2] || "",
    province: parts[3] || "",
    zip: parts[4] || "",
    country: parts[5] || "India",
  };
}


// 🔹 Add Note to Shopify Order
router.post("/api/shopify/add-note", async (req, res) => {
  const { orderId, note } = req.body;
  if (!orderId || !note) return res.status(400).json({ error: "Missing fields" });
  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2023-10/orders/${orderId}.json`; 
    await axios.put(
      url,
      { order: { id: orderId, note } },
      { headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to update note" });
  }
});

module.exports = router;
