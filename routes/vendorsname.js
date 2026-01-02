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
    const body = { ...req.body };
 
    if (body.hasGST && body.gstNumber) {
      body.gstNumber = String(body.gstNumber).trim().toUpperCase();
    } else {
      body.gstNumber = "";
      body.hasGST = false;
    }

    const vendor = await Vendor.create(body);
    res.json(vendor);
  } catch (err) { 
    if (err?.code === 11000) {
      return res.status(409).json({ error: "GST number already exists" });
    }
    res.status(500).json({ error: "Failed to create vendor" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await Vendor.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete vendor" });
  }
});

module.exports = router;
