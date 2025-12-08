// routes/PurchaseRcrds.js
const express = require("express");
const router = express.Router();

// Match your exact model export:
const PurchaseRecord = require("../models/PurchaseRcrd");


// ----------------------
// GET ALL PURCHASE RECORDS
// ----------------------
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 });

    return res.json(records);
  } catch (err) {
    console.error("GET /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});


// ----------------------
// CREATE RECORD
// ----------------------
router.post("/", async (req, res) => {
  try {
    const created = await PurchaseRecord.create(req.body);
    return res.json(created);
  } catch (err) {
    console.error("POST /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to create purchase record" });
  }
});


// ----------------------
// UPDATE RECORD
// ----------------------
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Record not found" });
    }

    return res.json(updated);
  } catch (err) {
    console.error("PATCH /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to update purchase record" });
  }
});


// ----------------------
// SOFT DELETE
// ----------------------
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );

    if (!deleted) {
      return res.status(404).json({ error: "Record not found" });
    }

    return res.json(deleted);
  } catch (err) {
    console.error("DELETE /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to delete purchase record" });
  }
});


module.exports = router;
