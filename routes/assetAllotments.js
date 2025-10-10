// routes/assetAllotments.js
const express = require("express");
const router = express.Router();
const AssetAllotment = require("../models/AssetAllotment");
const Employee = require("../models/Employee");

// GET (unchanged)
router.get("/", async (_req, res) => {
  try {
    const items = await AssetAllotment.find()
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 });
    res.json(items);
  } catch (err) {
    console.error("GET /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to fetch allotments" });
  }
});

// POST (only array)
router.post("/", async (req, res) => {
  try {
    const { employeeId, name, company, model, assetCode, allotmentImageUrls } = req.body;

    if (!employeeId || !name || !company || !model || !assetCode) {
      return res.status(400).json({
        message: "employeeId, name, company, model, and assetCode are required",
      });
    }

    const emp = await Employee.findById(employeeId);
    if (!emp) return res.status(404).json({ message: "Employee not found" });

    let imageUrls = Array.isArray(allotmentImageUrls) ? allotmentImageUrls : [];
    imageUrls = imageUrls.filter(Boolean).map((u) => String(u).trim()).slice(0, 50);

    const doc = await AssetAllotment.create({
      employee: employeeId,
      name: String(name).trim(),
      company: String(company).trim(),
      model: String(model).trim(),
      assetCode: String(assetCode).trim(),
      allotmentImageUrls: imageUrls,
      status: "allocated",
      allottedAt: new Date(),
    });

    const populated = await doc.populate("employee", "fullName email");
    res.status(201).json(populated);
  } catch (err) {
    console.error("POST /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to create allotment" });
  }
});

module.exports = router;
