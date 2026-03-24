const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");

// GET /api/leads/retention/active-counts
router.get("/active-counts", async (req, res) => {
  try {
    const matchQuery = {
      salesStatus: "Sales Done",
      $or: [
        { retentionStatus: { $regex: /^active$/i } },
        { retentionStatus: { $exists: false } },
        { retentionStatus: null },
        { retentionStatus: "" },
      ],
    };

    const results = await Lead.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: { $ifNull: ["$healthExpertAssigned", "Unassigned"] },
          activeCount: { $sum: 1 },
        },
      },
      { $sort: { activeCount: -1 } },
    ]);

    res.status(200).json(results);
  } catch (error) {
    console.error("Error in /active-counts:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;