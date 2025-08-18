const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const DelhiverySettlement = require("../models/DelhiverySettlement");

const upload = multer({ dest: "uploads/" });

// Helper to safely read a field from possible header variants
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const records = [];

    fs.createReadStream(filePath)
      .pipe(
        csv({
          // Normalize headers: remove BOM, trim, collapse internal spaces
          mapHeaders: ({ header }) =>
            header
              .replace(/\uFEFF/g, "") // strip BOM if present
              .replace(/\s+/g, " ")   // collapse multiple spaces to single
              .trim(),
          separator: ",",
        })
      )
      .on("data", (row) => {
        // Example headers in CSV:
        // AWB NO, UTR NO, AMOUNT, SETTLED DATE, ORDER ID
        const awbNo = pick(row, ["AWB NO", "AWB No", "AWB", "Waybill", "Waybill No"]);
        const utrNo = pick(row, ["UTR NO", "UTR No", "UTR"]);
        const amountRaw = pick(row, ["AMOUNT", "Amount"]);
        const amount = amountRaw ? parseFloat(amountRaw.toString().replace(/[,₹ ]/g, "")) : 0;
        const settledDate = pick(row, ["SETTLED DATE", "Settled Date"]);
        const orderId = pick(row, ["ORDER ID", "Order ID", "Order"]);

        records.push({
          uploadDate: new Date(),
          awbNo,
          utrNo,
          amount: isNaN(amount) ? 0 : amount,
          settledDate,
          orderId,
        });
      })
      .on("end", async () => {
        try {
          if (records.length === 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ error: "No rows parsed from CSV." });
          }
          await DelhiverySettlement.insertMany(records);
          fs.unlinkSync(filePath);
          res.json({ message: "Upload successful", inserted: records.length });
        } catch (e) {
          console.error("Insert error:", e);
          res.status(500).json({ error: "DB insert failed" });
        }
      })
      .on("error", (e) => {
        console.error("CSV parse error:", e);
        res.status(400).json({ error: "Invalid CSV" });
      });
  } catch (err) {
    console.error("Delhivery upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const totalCount = await DelhiverySettlement.countDocuments();
    const data = await DelhiverySettlement.find()
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ data, page, limit, totalCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Delhivery data" });
  }
});

module.exports = router;
