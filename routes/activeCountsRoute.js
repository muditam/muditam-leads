const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead"); // Adjust the path based on your project structure

// GET /api/leads/retention/active-counts
router.get("/active-counts", async (req, res) => {
  try {
    // Build the query without date filters
    const matchQuery = {
      salesStatus: "Sales Done",
      $or: [
        { retentionStatus: "Active" },
        { retentionStatus: { $exists: false } },
      ],
    };

    // Aggregate by healthExpertAssigned and count active leads
    const results = await Lead.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$healthExpertAssigned", // Group by agent's name
          activeCount: { $sum: 1 },       // Count matching leads
        },
      },
    ]);

    res.status(200).json(results);
  } catch (error) {
    console.error("Error in /active-counts:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;
