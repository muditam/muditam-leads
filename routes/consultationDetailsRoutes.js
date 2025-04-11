const express = require("express");
const ConsultationDetails = require("../models/ConsultationDetails");

const router = express.Router();

// GET all consultation details 
router.get("/", async (req, res) => {
  try {
    const query = {};
    if (req.query.customerId) {
      query.customerId = req.query.customerId;
    }
    const consultations = await ConsultationDetails.find(query);
    res.status(200).json(consultations);
  } catch (error) {
    console.error("Error fetching consultation details:", error);
    res.status(500).json({ message: "Error fetching consultation details", error: error.message });
  }
});

// GET a single consultation detail by ID
router.get("/:id", async (req, res) => {
  try {
    const consultation = await ConsultationDetails.findById(req.params.id);
    if (!consultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }
    res.status(200).json(consultation);
  } catch (error) {
    console.error("Error fetching consultation detail:", error);
    res.status(500).json({ message: "Error fetching consultation detail", error: error.message });
  }
});

// POST a new consultation detail or update existing one for the same customerId
router.post("/", async (req, res) => {
  try {
    const { customerId, presales, consultation, closing } = req.body;
    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }

    // Build an update object based on what is sent in the payload.
    const updateData = {};
    if (presales) {
      updateData.presales = presales;
    }
    if (consultation) {
      updateData.consultation = consultation;
    }
    if (closing) {
      updateData.closing = closing;
    }

    const options = { new: true, upsert: true, runValidators: true };
    const updatedConsultation = await ConsultationDetails.findOneAndUpdate(
      { customerId: customerId },
      { $set: updateData },
      options
    );

    res.status(200).json({
      message: "Consultation detail saved/updated successfully",
      consultation: updatedConsultation,
    });
  } catch (error) {
    console.error("Error saving consultation detail:", error);
    res.status(500).json({ message: "Error saving consultation detail", error: error.message });
  }
});

// PUT to update a consultation detail by ID
router.put("/:id", async (req, res) => {
  try {
    const updatedConsultation = await ConsultationDetails.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedConsultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }
    res.status(200).json({
      message: "Consultation detail updated successfully",
      consultation: updatedConsultation,
    });
  } catch (error) {
    console.error("Error updating consultation detail:", error);
    res.status(500).json({ message: "Error updating consultation detail", error: error.message });
  }
});

// DELETE a consultation detail by ID
router.delete("/:id", async (req, res) => {
  try {
    const deletedConsultation = await ConsultationDetails.findByIdAndDelete(req.params.id);
    if (!deletedConsultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }
    res.status(200).json({ message: "Consultation detail deleted successfully" });
  } catch (error) {
    console.error("Error deleting consultation detail:", error);
    res.status(500).json({ message: "Error deleting consultation detail", error: error.message });
  }
});

module.exports = router;
