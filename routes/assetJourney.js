// routes/assetJourney.js
const express = require("express");
const router = express.Router();
const AssetAllotment = require("../models/AssetAllotment");


// GET /api/asset-journey/:assetCode
// Returns full journey (allocated + returned) for that assetCode
router.get("/:assetCode", async (req, res) => {
  try {
    const { assetCode } = req.params;


    const rows = await AssetAllotment.find({
      assetCode: String(assetCode).trim(),
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 }); // timeline oldest -> newest


    res.json(rows);
  } catch (err) {
    console.error("GET /asset-journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});


module.exports = router;



