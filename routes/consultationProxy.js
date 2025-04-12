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
            body { font-family: Arial, sans-serif; margin: 20px; padding: 20px; line-height: 1.6; }
            h1, h2 { color: #333; }
            .section { margin-bottom: 20px; text-align: left;}
            .label { font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Consultation Plan for ${customer.name}</h1>
          
          <div class="section">
            <p>${customer.name}</p>
            <p>Diabetes<br> Management<br> Plan</p>
            <p>${(consultationDetails.closing?.courseDuration || []).join(", ") || "None"}</p>
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