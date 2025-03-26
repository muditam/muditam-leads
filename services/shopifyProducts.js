const express = require("express");
const router = express.Router();
const axios = require("axios"); 

/**
 * GET /api/shopify/products
 * @param {string} req.query.query - The text to search in product titles 
 */
router.get("/products", async (req, res) => {
  const { query = "" } = req.query;   
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
 
  try { 
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/products.json?status=active&title=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    // response.data.products is an array of matching products
    res.json(response.data.products);
  } catch (error) {
    console.error("Error fetching products from Shopify:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error fetching products from Shopify",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
