const express = require("express");
const router = express.Router();
const Template = require("../models/Template");


// Create a new template


router.post("/", async (req, res) => {
  try {
    const { purpose, templateBody, language, createdBy, templateFor, createdByRole } = req.body;


    const newTemplate = new Template({
      purpose,
      templateBody,
      language,
      createdBy,
      templateFor,
      createdByRole
    });
    await newTemplate.save();


    res
      .status(201)
      .json({ message: "Template added successfully", template: newTemplate });
  } catch (error) {
    console.error("Error adding template:", error);
    res.status(500).json({ message: "Error adding template", error });
  }
});


router.get("/", async (req, res) => {
  try {
    const { userRole, createdBy, selectedAgent, language, search } = req.query;
    let filter = {};

    if (language && language !== "All") filter.language = language;

    if (search) {
      filter.$or = [
        { purpose: { $regex: search, $options: "i" } },
        { templateBody: { $regex: search, $options: "i" } },
      ];
    }

    if (userRole === "Manager") {
      filter.createdBy = createdBy;
      if (selectedAgent) {
        filter.createdBy = selectedAgent;  // Allow selecting templates created by a specific agent
      }
    } else if (userRole === "Sales Agent") {
      filter.$or = [
        { createdBy: createdBy }, // Show own templates
        { createdByRole: "Manager", templateFor: "Acquisition" }, // Show Manager-created "Acquisition" templates
      ];

      if (selectedAgent) {
        filter.createdBy = selectedAgent;  // Allow filtering by Sales Agent
      }
    } else if (userRole === "Retention Agent") {
      filter.$or = [
        { createdBy: createdBy }, // Show own templates
        { createdByRole: "Manager", templateFor: "Retention" }, // Show Manager-created "Retention" templates
      ];

      if (selectedAgent) {
        filter.createdBy = selectedAgent;  // Allow filtering by Retention Agent
      }
    }

    const templates = await Template.aggregate([
      { $match: filter },
      {
        $addFields: {
          sortPriority: {
            $cond: [{ $eq: ["$createdByRole", "Manager"] }, 2, 1], // Manager templates will come last
          },
        },
      },
      { $sort: { sortPriority: 1, _id: -1 } },  // Sort: own templates first, then manager templates
    ]);

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
    const updatedTemplate = await Template.findByIdAndUpdate(id, req.body, {
      new: true,
    });


    if (!updatedTemplate)
      return res.status(404).json({ message: "Template not found" });


    res
      .status(200)
      .json({
        message: "Template updated successfully",
        template: updatedTemplate,
      });
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



