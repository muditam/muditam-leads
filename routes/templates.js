const express = require("express");
const router = express.Router();
const Template = require("../models/Template");

// Create a new template
router.post("/", async (req, res) => {
  try {
    const { purpose, templateBody, language, createdBy } = req.body;

    const newTemplate = new Template({ purpose, templateBody, language, createdBy });
    await newTemplate.save();

    res.status(201).json({ message: "Template added successfully", template: newTemplate });
  } catch (error) {
    console.error("Error adding template:", error);
    res.status(500).json({ message: "Error adding template", error });
  }
});

// Fetch all templates (Filtered by creator and language)
router.get("/", async (req, res) => {
  try {
    const { createdBy, language, search } = req.query;
    let filter = {};

    if (createdBy) filter.createdBy = createdBy;
    if (language && language !== "All") filter.language = language;
    if (search) {
      filter.$or = [
        { purpose: { $regex: search, $options: "i" } },
        { templateBody: { $regex: search, $options: "i" } },
      ];
    }

    const templates = await Template.find(filter);
    res.status(200).json(templates);
  } catch (error) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ message: "Error fetching templates", error });
  }
});

// Update a template
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updatedTemplate = await Template.findByIdAndUpdate(id, req.body, { new: true });

    if (!updatedTemplate) return res.status(404).json({ message: "Template not found" });

    res.status(200).json({ message: "Template updated successfully", template: updatedTemplate });
  } catch (error) {
    console.error("Error updating template:", error);
    res.status(500).json({ message: "Error updating template", error });
  }
});

// Delete a template
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Template.findByIdAndDelete(id);
    res.status(200).json({ message: "Template deleted successfully" });
  } catch (error) {
    console.error("Error deleting template:", error);
    res.status(500).json({ message: "Error deleting template", error });
  }
});

module.exports = router;
