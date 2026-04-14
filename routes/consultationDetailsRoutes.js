const express = require("express");
const mongoose = require("mongoose");
const ConsultationDetails = require("../models/ConsultationDetails");
const requireSession = require("../middleware/requireSession");

const router = express.Router();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET all consultation details
router.get("/", requireSession, async (req, res) => {
  try {
    const query = {};
    if (req.query.customerId) {
      query.customerId = req.query.customerId;
    }

    const consultations = await ConsultationDetails.find(query);
    return res.status(200).json(consultations);
  } catch (error) {
    console.error("Error fetching consultation details:", error);
    return res.status(500).json({
      message: "Error fetching consultation details",
      error: error.message,
    });
  }
});

// GET a single consultation detail by ID
router.get("/:id", requireSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid consultation detail id" });
    }

    const consultation = await ConsultationDetails.findById(req.params.id);
    if (!consultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }

    return res.status(200).json(consultation);
  } catch (error) {
    console.error("Error fetching consultation detail:", error);
    return res.status(500).json({
      message: "Error fetching consultation detail",
      error: error.message,
    });
  }
});

// CREATE / UPSERT consultation details by customerId
router.post("/", requireSession, async (req, res) => {
  try {
    const { customerId, presales, consultation, closing } = req.body;

    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }

    const updateData = {};

    if (presales && typeof presales === "object") {
      Object.keys(presales).forEach((key) => {
        if (key !== "leadStatus" && key !== "subLeadStatus") {
          updateData[`presales.${key}`] = presales[key];
        }
      });
    }

    if (consultation && typeof consultation === "object") {
      Object.keys(consultation).forEach((key) => {
        updateData[`consultation.${key}`] = consultation[key];
      });
    }

    if (closing && typeof closing === "object") {
      Object.keys(closing).forEach((key) => {
        updateData[`closing.${key}`] = closing[key];
      });
    }

    const updatedConsultation = await ConsultationDetails.findOneAndUpdate(
      { customerId },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );

    return res.status(200).json({
      message: "Consultation detail saved/updated successfully",
      consultation: updatedConsultation,
    });
  } catch (error) {
    console.error("Error saving consultation detail:", error);
    return res.status(500).json({
      message: "Error saving consultation detail",
      error: error.message,
    });
  }
});

// PUT to update a consultation detail by ID
router.put("/:id", requireSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid consultation detail id" });
    }

    const updatedConsultation = await ConsultationDetails.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!updatedConsultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }

    return res.status(200).json({
      message: "Consultation detail updated successfully",
      consultation: updatedConsultation,
    });
  } catch (error) {
    console.error("Error updating consultation detail:", error);
    return res.status(500).json({
      message: "Error updating consultation detail",
      error: error.message,
    });
  }
});

// DELETE a consultation detail by ID
router.delete("/:id", requireSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid consultation detail id" });
    }

    const deletedConsultation = await ConsultationDetails.findByIdAndDelete(
      req.params.id
    );

    if (!deletedConsultation) {
      return res.status(404).json({ message: "Consultation detail not found" });
    }

    return res
      .status(200)
      .json({ message: "Consultation detail deleted successfully" });
  } catch (error) {
    console.error("Error deleting consultation detail:", error);
    return res.status(500).json({
      message: "Error deleting consultation detail",
      error: error.message,
    });
  }
});

module.exports = router;