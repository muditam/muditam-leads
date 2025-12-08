const express = require("express");
const router = express.Router();
const PurchaseRecord = require("../models/PurchaseRecord");

// ----------------------
// GET ALL PURCHASE RECORDS
// ----------------------
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error("GET /purchase-records error:", err);
    res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// ----------------------
// CREATE A RECORD (INLINE ADD)
// ----------------------
router.post("/", async (req, res) => {
  try {
    const record = await PurchaseRecord.create(req.body);
    res.json(record);
  } catch (err) {
    console.error("POST /purchase-records error:", err);
    res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// ----------------------
// UPDATE A RECORD (INLINE PATCH)
// ----------------------
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    console.error("PATCH /purchase-records error:", err);
    res.status(500).json({ error: "Failed to update purchase record" });
  }
});

// ----------------------
// SOFT DELETE RECORD
// ----------------------
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    console.error("DELETE /purchase-records error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

module.exports = router;
