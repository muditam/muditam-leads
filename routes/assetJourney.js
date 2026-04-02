// routes/assetJourney.js
const express = require("express");
const router = express.Router();
const AssetAllotment = require("../models/AssetAllotment");
 
router.get("/:assetCode", async (req, res) => {
  try {
    const { assetCode } = req.params;
 
 
    const rows = await AssetAllotment.find({
      assetCode: String(assetCode).trim(),
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 }); 
 
    res.json(rows);
  } catch (err) {
    console.error("GET /asset-journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});
 
 
module.exports = router;