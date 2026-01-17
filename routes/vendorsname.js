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


// CREATE VENDOR
router.post("/", async (req, res) => {
  try {
    const body = { ...req.body };


    // Validate vendor name
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: "Vendor name is required" });
    }


    // Normalize GST
    let gst = "";
    if (body.hasGST && body.gstNumber) {
      gst = String(body.gstNumber).trim().toUpperCase();
    }


    // STRICT CHECK: Block duplicate GST globally
    if (gst) {
      const exists = await Vendor.findOne({
        gstNumber: gst,
      }).lean();


      if (exists) {
        return res.status(409).json({
          error: `GST number "${gst}" is already registered with vendor "${exists.name}"`,
        });
      }
    }


    // Final assignment
    body.name = body.name.trim();
    body.hasGST = !!gst;
    body.gstNumber = gst;


    const vendor = await Vendor.create(body);
    return res.json(vendor);
  } catch (err) {
    console.error("Error creating vendor:", err);
   
    // Handle MongoDB duplicate key error (backup check)
    if (err.code === 11000) {
      return res.status(409).json({
        error: "GST number already exists in the system",
      });
    }
   
    return res.status(500).json({ error: "Failed to create vendor" });
  }
});


// DELETE VENDOR
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

