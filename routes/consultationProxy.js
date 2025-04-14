const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

// GET route for App Proxy using customer ID directly
router.get("/proxy/consultation/:id", async (req, res) => {
  const customerId = req.params.id;

  try {
    // Fetch customer data using customerId
    const customer = await Customer.findById(customerId).lean();
    if (!customer) {
      return res.status(404).send("Customer not found.");
    }

    // Fetch consultation details using customerId
    const consultationDetails = await ConsultationDetails.findOne({ customerId }).lean();
    if (!consultationDetails) {
      return res.status(404).send("Consultation details not found.");
    }

    // Build an HTML response that combines customer and consultation details
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Consultation Plan for ${customer.name}</title>
          <!-- Prevent search engines from indexing this page -->
          <meta name="robots" content="noindex, nofollow">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              margin: 20px; 
              padding: 20px; 
              line-height: 1.6; 
              background-size: cover;
              background-repeat: no-repeat;
              background-position: center;
            }
            /* Mobile background image for widths less than 768px */
            @media (max-width: 767px) {
              body {
                background-image: url("https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_12_36_24_PM_1.png?v=1744455727");
              }
            }
            /* Desktop background image for widths 768px and above */
            @media (min-width: 768px) {
              body {
                background-image: url("https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_04_42_09_PM_1.jpg?v=1744455727");
              }
            }
            h1, h2 { color: #333; }
            .section { margin-bottom: 20px; }
            .label { font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="section"> 
            <p class="label">${customer.name}'s</p> 
            <h1>DIABETES</h1>
            <h2>MANAGEMENT PLAN</h2>
            <p class="label">${consultationDetails.closing && consultationDetails.closing.courseDuration ? consultationDetails.closing.courseDuration : "Not provided"}</p> 
          </div>
        </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("Error in consultation proxy route:", error);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;