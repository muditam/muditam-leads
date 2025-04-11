const express = require("express");
const router = express.Router();
const Customer = require("../models/Customer");
const ConsultationDetails = require("../models/ConsultationDetails");

router.get("/proxy/consultation/:slug", async (req, res) => {
  const { slug } = req.params;

  try {
    // You can use slug = customerId, or a custom unique field (e.g. phone + name encoded)
    const customer = await Customer.findById(slug);
    if (!customer) return res.status(404).send("Customer not found");

    const consultation = await ConsultationDetails.findOne({ customerId: customer._id });
    if (!consultation) return res.status(404).send("Consultation data not found");

    // Example HTML response
    const html = `
      <html>
        <head>
          <title>Consultation for ${customer.name}</title>
          <meta name="robots" content="noindex, nofollow">
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; line-height: 1.6; }
            h1 { color: #444; }
            .section { margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>Hello, ${customer.name}</h1>
          <p><strong>Phone:</strong> ${customer.phone}</p>
          <p><strong>Age:</strong> ${customer.age}</p>
          <p><strong>Location:</strong> ${customer.location}</p>

          <div class="section">
            <h2>Consultation Summary</h2>
            <p><strong>Fasting Sugar:</strong> ${consultation.presales?.fastingSugar || "N/A"}</p>
            <p><strong>Duration of Diabetes:</strong> ${consultation.presales?.durationOfDiabetes || "N/A"}</p>
            <p><strong>Expert Assigned:</strong> ${consultation.presales?.assignExpert || "Not Assigned"}</p>
            <p><strong>Doctor Notes:</strong> ${consultation.presales?.notes || "No notes yet"}</p>
          </div>

          <div class="section">
            <h2>Selected Products</h2>
            <ul>
              ${(consultation.consultation?.selectedProducts || []).map(p => `<li>${p}</li>`).join('') || "<li>No products selected</li>"}
            </ul>
          </div>
        </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("App Proxy error:", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
