const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const RazorpaySettlement = require("../models/RazorpaySettlement");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

router.post("/upload", upload.single("file"), async (req, res) => {
  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {
      row.uploadDate = new Date(); // Add upload date
      results.push(row);
    })
    .on("end", async () => {
      try {
        await RazorpaySettlement.insertMany(results);
        fs.unlinkSync(req.file.path);
        res.json({ message: "Upload successful" });
      } catch (error) {
        console.error("DB Save Error:", error);
        res.status(500).json({ error: "Failed to save data" });
      }
    });
});

router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const [data, total] = await Promise.all([
      RazorpaySettlement.find().skip(skip).limit(limit).sort({ uploadDate: -1 }),
      RazorpaySettlement.countDocuments(),
    ]);

    res.json({
      data,
      page,
      totalPages: Math.ceil(total / limit),
      totalRecords: total,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

module.exports = router;
