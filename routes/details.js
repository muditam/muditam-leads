// routes/details.js
const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");

// Save or update details
router.post("/save-details", async (req, res) => {
  const { contactNumber, details } = req.body;
  if (!contactNumber) return res.status(400).json({ message: "Missing contactNumber" });

  try {
    const setFields = {};
    const unsetFields = {};

    for (const key in details) {
      const value = details[key];
      const path = `details.${key}`;

      if (
        value === "" ||
        value === null ||
        (Array.isArray(value) && value.length === 0)
      ) {
        // Mark field to be unset (deleted)
        unsetFields[path] = "";
      } else {
        // Mark field to be set (updated)
        setFields[path] = value;
      }
    }

    const updateObj = {};
    if (Object.keys(setFields).length > 0) updateObj.$set = setFields;
    if (Object.keys(unsetFields).length > 0) updateObj.$unset = unsetFields;

    if (Object.keys(updateObj).length === 0) {
      // Nothing to update
      return res.status(400).json({ message: "No valid details to update" });
    }

    const updatedLead = await Lead.findOneAndUpdate(
      { contactNumber },
      updateObj,
      { new: true, upsert: false }
    );

    if (!updatedLead) return res.status(404).json({ message: "Lead not found" });

    res.status(200).json({ message: "Details updated", lead: updatedLead });
  } catch (err) {
    console.error("Error saving details:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

 
// Get details
router.get("/get-details/:contactNumber", async (req, res) => {
    try {
      const lead = await Lead.findOne({ contactNumber: req.params.contactNumber });
      if (!lead) return res.status(404).json({ message: "Not found" });
  
      res.json({
        details: lead.details || {},
        followUps: lead.followUps || [], 
      });
    } catch (error) {
      console.error("Error getting details:", error);
      res.status(500).json({ message: "Server error" });
    }
  });
  

// Update entire lead document
router.put("/update-details/:contactNumber", async (req, res) => {
  try {
    const { contactNumber } = req.params;
    const updateData = req.body;

    const existingLead = await Lead.findOne({ contactNumber });
    if (!existingLead) {
      return res.status(404).json({ message: "Lead not found." });
    }

    const updatedLead = await Lead.findOneAndUpdate(
      { contactNumber },
      { $set: updateData },
      { new: true }
    );

    res.status(200).json(updatedLead);
  } catch (error) {
    console.error("Error updating details:", error);
    res.status(500).json({ message: "Server error." });
  }
});

// POST: Save or update followups
router.post("/save-followups", async (req, res) => {
    const { contactNumber, followUps } = req.body;
    if (!contactNumber) return res.status(400).json({ message: "Missing contactNumber" });
  
    try {
      const updated = await Lead.findOneAndUpdate(
        { contactNumber },
        { $set: { followUps } },
        { new: true }
      );
      if (!updated) return res.status(404).json({ message: "Lead not found" });
      res.status(200).json({ message: "Followups updated", lead: updated });
    } catch (err) {
      console.error("Error saving followups:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  });
  
  

module.exports = router;