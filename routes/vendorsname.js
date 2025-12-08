// routes/vendorsname.js
const express = require("express");
const router = express.Router();
const Vendor = require("../models/Vendorname"); 

// GET VENDORS
router.get("/", async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ createdAt: -1 });
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch vendors" });
  }
});

// ADD VENDOR
router.post("/", async (req, res) => {
  try {
    const vendor = await Vendor.create(req.body);
    res.json(vendor);
  } catch (err) {
    res.status(500).json({ error: "Failed to create vendor" });
  }
});

module.exports = router;
