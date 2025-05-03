const express = require("express");
const ConsultationDetails = require("../models/ConsultationDetails");

const router = express.Router();

/**
 * GET /api/consultation-full-history?customerId=...
 * Returns all data from the ConsultationDetails document for the given customer,
 * excluding the checklist subdocuments.
 */
router.get("/", async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }
    const consultation = await ConsultationDetails.findOne({ customerId }).populate("presales.assignExpert", "fullName").lean();
    if (!consultation) {
      return res.status(404).json({ message: "No consultation details found for this customer." });
    }
    // Convert Mongoose document to a plain JS object.
    const data = consultation;

    // Remove checklist fields if present.
    if (data.presales && data.presales.checklist) {
      delete data.presales.checklist;
    }
    if (data.consultation && data.consultation.checklist) {
      delete data.consultation.checklist;
    }
    // (If closing had a checklist field, remove it similarly.)

    res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching full consultation history:", error);
    res.status(500).json({ message: "Error fetching consultation history", error: error.message });
  }
});

module.exports = router;
