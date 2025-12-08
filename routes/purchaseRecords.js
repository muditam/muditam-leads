const express = require("express");
const router = express.Router();
const PurchaseRecord = require("../models/PurchaseRecord");
const XLSX = require("xlsx");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

// GET ALL RECORDS
router.get("/", async (req, res) => {
  try {
    const records = await PurchaseRecord.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});

// CREATE (Inline Add)
router.post("/", async (req, res) => {
  try {
    const record = await PurchaseRecord.create(req.body);
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create purchase record" });
  }
});

// UPDATE
router.patch("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update purchase record" });
  }
});

// SOFT DELETE
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

// BULK UPLOAD ONLY (NO WASABI)
router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const file = req.file;
    const defaultDate = req.body.date;

    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const created = [];

    for (const r of rows) {
      const record = await PurchaseRecord.create({
        date: r["Date"] || defaultDate,
        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",
        vendorName: r["Vendor Name"] || "",
        amount: r["Amount"] || 0,
        matched2B: false,
        tally: false,
      });

      created.push(record);
    }

    res.json(created);
  } catch (err) {
    console.error("Bulk upload error:", err);
    res.status(500).json({ error: "Bulk upload failed" });
  }
});

module.exports = router;
