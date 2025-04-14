// Updated consultationProxy.js for JSON response
const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

// GET route that returns JSON data for a given customerId
router.get("/:id", async (req, res) => {
  const customerId = req.params.id;

  try {
    // Fetch customer data using customerId
    const customer = await Customer.findById(customerId).lean();
    if (!customer) {
      return res.status(404).json({ error: "Customer not found." });
    }

    // Fetch consultation details using customerId
    const consultationDetails = await ConsultationDetails.findOne({ customerId }).lean();
    if (!consultationDetails) {
      return res.status(404).json({ error: "Consultation details not found." });
    }

    // Instead of an HTML string, send a JSON object with both data sets
    res.json({
      customer,
      consultationDetails,
    });
  } catch (error) {
    console.error("Error in consultation proxy route:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
