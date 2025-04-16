const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");

// GET duplicates: Returns duplicate contact numbers along with their count and all full lead documents.
router.get("/duplicates", async (req, res) => {
  try {
    const duplicates = await Lead.aggregate([
      { 
        $match: { 
          contactNumber: { $exists: true, $ne: null, $ne: "" } 
        } 
      },
      {
        $group: {
          _id: "$contactNumber",
          count: { $sum: 1 },
          leads: { $push: "$$ROOT" }
        },
      },
      { $match: { count: { $gt: 1 } } },
      {
        $project: {
          contactNumber: "$_id",
          duplicateCount: "$count",
          leads: 1,
          _id: 0,
        },
      },
    ]);
    res.json(duplicates);
  } catch (err) {
    console.error("Error fetching duplicates:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT update duplicate group: Updates all leads with the old contact number using the updated data.
router.put("/update-duplicate-group", async (req, res) => {
  try {
    const { oldContactNumber, updatedData } = req.body;
    if (!oldContactNumber || !updatedData) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    const updateResult = await Lead.updateMany(
      { contactNumber: oldContactNumber },
      { $set: updatedData }
    );
    res.json({ message: "Duplicate group updated", updateResult });
  } catch (err) {
    console.error("Error updating duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE duplicate group: Deletes all leads with the provided contact number.
router.delete("/duplicate-number", async (req, res) => {
  try {
    const { contactNumber } = req.body;
    if (!contactNumber) {
      return res.status(400).json({ error: "Missing contact number" });
    }
    const deleteResult = await Lead.deleteMany({ contactNumber: contactNumber });
    res.json({ message: "Leads with duplicate group deleted", deleteResult });
  } catch (err) {
    console.error("Error deleting duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
