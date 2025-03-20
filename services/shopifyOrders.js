// routes/shopifyOrders.js (or a separate file like shopifyCustomers.js)
const express = require("express");
const axios = require("axios");
const router = express.Router();
 
/**
 * GET /api/shopify/customer-orders?phone=<phoneNumber>
 * Searches Shopify customers by phone and returns their addresses.
 */
router.get("/customer-orders", async (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ message: "Phone number is required." });
  }

  try {
    // Shopify store details
    const shopifyStore = process.env.SHOPIFY_STORE_NAME;
    const accessToken = process.env.SHOPIFY_API_SECRET;

    // Use Shopify's Customer Search endpoint:
    // e.g. GET /admin/api/2024-04/customers/search.json?query=phone:<phone>
    // See: https://shopify.dev/docs/api/admin-rest/2023-04/resources/customer#search-customers
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
      phone
    )}`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    // The response structure is { customers: [ { ...customerData } ] }
    const customers = response.data.customers || [];

    if (customers.length === 0) {
      // No customer found with this phone
      return res.json({ addresses: [] });
    }

    // For simplicity, assume the first matched customer is the one we want
    const customer = customers[0];

    // "addresses" is an array in the customer object
    // We'll transform them into a simpler shape that matches your Payment UI
    // e.g. { fullName, phone, address1, address2, city, state, country, pincode }
    const addresses = customer.addresses.map((addr) => ({
      fullName: `${addr.first_name || customer.first_name} ${
        addr.last_name || customer.last_name
      }`.trim(),
      phone: addr.phone || phone,
      address1: addr.address1 || "",
      address2: addr.address2 || "",
      city: addr.city || "",
      state: addr.province || "",
      country: addr.country || "",
      pincode: addr.zip || "",
      valid: true,
    }));

    return res.json({ addresses });
  } catch (error) {
    console.error("Error fetching customer by phone:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Error fetching customer by phone",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
