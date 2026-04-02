// routes/assetAllotments.js
const express = require("express");
const router = express.Router();
 
const AssetAllotment = require("../models/AssetAllotment");
const Employee = require("../models/Employee");

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
 
router.post("/", async (req, res) => {
  try {
    const {
      employeeId,
      name,
      company,
      model,
      assetCode,
      allotmentImageUrls,
    } = req.body;
 
    if (!employeeId || !name || !company || !model || !assetCode) {
      return res.status(400).json({
        message:
          "employeeId, name, company, model, and assetCode are required",
      });
    }
 
    const emp = await Employee.findById(employeeId);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }
 
    let imageUrls = Array.isArray(allotmentImageUrls)
      ? allotmentImageUrls
      : [];
    imageUrls = imageUrls
      .filter(Boolean)
      .map((u) => String(u).trim())
      .slice(0, 50);
 
    const now = new Date();
 
    const doc = await AssetAllotment.create({
      employee: employeeId,
      name: String(name).trim(),
      company: String(company).trim(),
      model: String(model).trim(),
      assetCode: String(assetCode).trim(),
      allotmentImageUrls: imageUrls,
      status: "allocated",
      allottedAt: now,
    });


    const populated = await doc.populate("employee", "fullName email");
    res.status(201).json(populated);
  } catch (err) {
    console.error("POST /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to create allotment" });
  }
});
 
router.patch("/:id/collect", async (req, res) => {
  try {
    const { id } = req.params;
    const { returnedAt, notes, returnImageUrls } = req.body;


    const retDate = returnedAt ? new Date(returnedAt) : new Date();
    if (Number.isNaN(retDate.getTime())) {
      return res.status(400).json({ message: "Invalid returnedAt date" });
    }
 
    let returnImgs = Array.isArray(returnImageUrls)
      ? returnImageUrls
      : [];
    returnImgs = returnImgs
      .filter(Boolean)
      .map((u) => String(u).trim())
      .slice(0, 50);
 
    const update = {
      returnedAt: retDate,
      notes: notes || "",
      status: "returned",
      returnImageUrls: returnImgs,
    };
 
    const doc = await AssetAllotment.findByIdAndUpdate(id, update, {
      new: true,
    }).populate("employee", "fullName email");
 
    if (!doc) {
      return res.status(404).json({ message: "Allotment not found" });
    }
 
    res.json(doc);
  } catch (err) {
    console.error("PATCH /asset-allotments/:id/collect error:", err);
    res.status(500).json({ message: "Failed to mark as collected" });
  }
});

router.get("/journey/:assetCode", async (req, res) => {
  try {
    const code = String(req.params.assetCode || "").trim();
    if (!code) {
      return res.status(400).json({ message: "assetCode is required" });
    }
 
    const rows = await AssetAllotment.find({
      assetCode: code,
      status: "returned",        
      returnedAt: { $ne: null },
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 });
 
    const timeline = rows.map((doc) => ({
      _id: doc._id,
      assetCode: doc.assetCode,
      name: doc.name,  
      assetName: doc.name,
      company: doc.company,
      model: doc.model,
 
      employee: doc.employee,  
      employeeName: doc.employee?.fullName || "",
      employeeId: doc.employee?._id || null,
 
      status: doc.status,          
      allottedAt: doc.allottedAt,    
      returnedAt: doc.returnedAt,   
 
      notes: doc.notes || "",
      allotmentImageUrls: doc.allotmentImageUrls || [],
      returnImageUrls: doc.returnImageUrls || [],
    }));
 
    res.json(timeline);
  } catch (err) {
    console.error("GET /asset-allotments/journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId) {
      return res.status(400).json({ message: "employeeId is required" });
    }
 
    const includeReturned =
      String(req.query.includeReturned || "0").trim() === "1";
 
    const filter = { employee: employeeId };
    if (!includeReturned) { 
      filter.status = { $ne: "returned" };
    }
 
    const items = await AssetAllotment.find(filter)
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 });
 
    res.json(items);
  } catch (err) {
    console.error(
      "GET /asset-allotments/employee/:employeeId error:",
      err
    );
    res.status(500).json({ message: "Failed to fetch employee allotments" });
  }
});
 
module.exports = router;

 