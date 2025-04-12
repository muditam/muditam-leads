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
            .section { margin-bottom: 20px; }
            .label { font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Consultation Plan for ${customer.name}</h1>
          
          <div class="section">
            <h2>Customer Details</h2>
            <p><span class="label">Name:</span> ${customer.name}</p>
            <p><span class="label">Phone:</span> ${customer.phone}</p>
            <p><span class="label">Age:</span> ${customer.age}</p>
            <p><span class="label">Location:</span> ${customer.location}</p>
          </div>
          
          <div class="section">
            <h2>Consultation Summary</h2>
            <p><span class="label">Expected Result:</span> ${consultationDetails.closing?.expectedResult || "Not provided"}</p>
            <p><span class="label">Preferred Diet:</span> ${consultationDetails.closing?.preferredDiet || "Not provided"}</p>
            <p><span class="label">Course Duration:</span> ${consultationDetails.closing?.courseDuration || "Not provided"}</p>
            <p><span class="label">Freebies:</span> ${(consultationDetails.closing?.freebie || []).join(", ") || "None"}</p>
            <p><span class="label">Blood Test:</span> ${consultationDetails.closing?.bloodTest || "Not specified"}</p>
          </div>
          
          <div class="section">
            <h2>Presales & Additional Info</h2>
            <p><span class="label">HbA1c:</span> ${consultationDetails.presales?.hba1c || "Not provided"}</p>
            <p><span class="label">Notes:</span> ${consultationDetails.presales?.notes || "None"}</p>
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
