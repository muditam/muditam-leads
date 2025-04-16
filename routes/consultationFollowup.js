const express = require("express");
const ConsultationDetails = require("../models/ConsultationDetails");

const router = express.Router();

/**
 * GET /api/consultation-followup?customerId=...
 * Returns the followups array from ConsultationDetails.
 */
router.get("/", async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }
    const consultation = await ConsultationDetails.findOne({ customerId });
    res.status(200).json({ followups: consultation?.followups || [] });
  } catch (error) {
    console.error("Error fetching follow-up details:", error);
    res.status(500).json({ message: "Error fetching follow-up details", error: error.message });
  }
});

/**
 * POST /api/consultation-followup
 * Updates the followups array in the ConsultationDetails document.
 * Expects { customerId, followups } in the body.
 */
router.post("/", async (req, res) => {
  try {
    const { customerId, followups } = req.body;
    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }
    const updated = await ConsultationDetails.findOneAndUpdate(
      { customerId },
      { $set: { followups } },
      { new: true, runValidators: true }
    );
    res.status(200).json({ followups: updated.followups });
  } catch (error) {
    console.error("Error saving follow-up details:", error);
    res.status(500).json({ message: "Error saving follow-up details", error: error.message });
  }
});

module.exports = router;
