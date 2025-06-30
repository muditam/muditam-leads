require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Razorpay = require("razorpay");

const router = express.Router();

// Shopify
const SHOPIFY_STORE = `${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

router.get("/api/shopify/customers", async (req, res) => {
  let phone = req.query.phone;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }
  // Remove all non-digits
  const digits = phone.replace(/\D/g, "");
  const normalizedOptions = [
    `+91${digits}`,
    `91${digits}`,
    digits.length === 10 ? digits : digits.slice(-10)
  ];

  let foundCustomer = null;
  let candidates = [];
  let searchQueries = [
    normalizedOptions[0], // "+91XXXXXXXXXX"
    normalizedOptions[1], // "91XXXXXXXXXX"
    normalizedOptions[2], // "XXXXXXXXXX"
  ];

  // Try each query, break when found
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
      // Log all for debugging
      console.log("DEBUG candidates", candidates.map(c => ({ id: c.id, phone: c.phone })));
      foundCustomer = candidates.find(c => {
        // Check customer root phone
        const cDigits = (c.phone || "").replace(/\D/g, "");
        if (cDigits.slice(-10) === digits.slice(-10)) return true;
        // ALSO check all address phones!
        if (c.addresses && c.addresses.length > 0) {
          return c.addresses.some(addr => {
            const aDigits = (addr.phone || "").replace(/\D/g, "");
            return aDigits.slice(-10) === digits.slice(-10);
          });
        }
        return false;
      });
      if (foundCustomer) break; 
    } catch (err) {
      // just continue
    }
  }

  if (!foundCustomer) {
    return res.json({ addresses: [] });
  }

  // Format all addresses
  const addresses = (foundCustomer.addresses || []).map(addr => ({
    id: addr.id,
    formatted: [
      addr.address1,
      addr.address2,
      addr.city,
      addr.province,
      addr.zip,
      addr.country,
    ].filter(Boolean).join(", "),
  }));

  res.json({ addresses });
});


router.post("/api/razorpay/generate-link", async (req, res) => {
  try {
    const { customerName, customerPhone, customerAddress, amount } = req.body;
    if (!customerName || !customerPhone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const response = await razorpay.paymentLink.create({
      amount: Math.round(Number(amount) * 100), // in paise
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
        address: customerAddress || "",
      },
      callback_url: "", // optional: you can add your post-payment webhook/callback
      callback_method: "get",
    });
    res.json({ paymentLink: response.short_url });
  } catch (error) {
    console.error("Razorpay Link Error:", error);
    res.status(500).json({ error: "Failed to generate payment link" });
  }
});

// --- Shopify Place Order ---
router.post("/api/shopify/place-order", async (req, res) => {
  try {
    const {
      customer,
      cartItems,
      paymentMethod,
      transactionId,
      shippingCharge,
      discount,
      notes,
    } = req.body;

    if (!customer || !cartItems || cartItems.length === 0 || !customer.address) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // Build line items
    const line_items = cartItems.map((item) => ({
      variant_id: item.id,
      quantity: item.quantity,
      price: item.price, // Shopify may ignore price for existing variants, but it's OK to send.
      title: item.productTitle,
    }));

    // Build order payload
    const orderData = {
      order: {
        line_items,
        customer: {
          first_name: customer.name || "",
          phone: customer.phone || "",
        },
        shipping_address: parseAddressString(customer.address),
        billing_address: parseAddressString(customer.address),
        financial_status: paymentMethod === "Prepaid" ? "paid" : "pending",
        note: notes || "",
        tags: paymentMethod,
        discount_codes: discount ? [{ code: "ManualDiscount", amount: String(discount), type: "fixed_amount" }] : [],
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
          paymentMethod === "Prepaid" && transactionId
            ? [
                {
                  kind: "sale",
                  status: "success",
                  amount: String(
                    line_items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0) +
                      Number(shippingCharge || 0) -
                      Number(discount || 0)
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

    res.json({ success: true, shopifyOrder: response.data.order });
  } catch (error) {
    console.error("Shopify Place Order Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to place order" });
  }
});

function parseAddressString(formatted) {
  if (!formatted) return { address1: "No Address Provided", country: "India" };
  const parts = formatted.split(",").map((s) => s.trim()).filter(Boolean);

  // Make sure at least address1 and country are filled
  return {
    address1: parts[0] || formatted,
    address2: parts[1] || "",
    city: parts[2] || "",
    province: parts[3] || "",
    zip: parts[4] || "",
    country: parts[5] || "India",
  };
}


module.exports = router;
