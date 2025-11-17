const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const RazorpaySettlement = require("../models/RazorpaySettlement");

const router = express.Router();

// store uploaded CSVs in /uploads/razorpay
const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "razorpay"),
});

// helper: parse number safely, remove commas
function toNumber(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// ===================== UPLOAD CSV =====================
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {
      // Map CSV headers to schema fields
      // Your CSV headers (from your message):
      // Upload Date, Transaction Entity, Entity ID, Amount, Currency,
      // Fee, Tax, Debit, Credit, Payment Method, Card Type, Issuer Name,
      // Created At, Order ID, Settlemet Id, Settlement UTR, Settled At, Settled By

      const mapped = {
        uploadDate: new Date(), // we store upload time, not CSV value
        transaction_entity:
          row["Transaction Entity"] ||
          row["Transaction entity"] ||
          row["transaction_entity"] ||
          "",
        entity_id:
          row["Entity ID"] || row["Entity Id"] || row["entity_id"] || "",
        amount: toNumber(row["Amount"]),
        currency: row["Currency"] || "",
        fee: toNumber(row["Fee"]),
        tax: toNumber(row["Tax"]),
        debit: toNumber(row["Debit"]),
        credit: toNumber(row["Credit"]),
        payment_method:
          row["Payment Method"] || row["Payment method"] || row["payment_method"] || "",
        card_type: row["Card Type"] || row["card_type"] || "",
        issuer_name: row["Issuer Name"] || row["issuer_name"] || "",
        entity_created_at:
          row["Created At"] || row["Created at"] || row["entity_created_at"] || "",
        order_id: row["Order ID"] || row["Order Id"] || row["order_id"] || "",
        // Note: your header has a typo "Settlemet Id"
        settlement_id:
          row["Settlemet Id"] ||
          row["Settlement Id"] ||
          row["settlement_id"] ||
          "",
        settlement_utr:
          row["Settlement UTR"] || row["Settlement Utr"] || row["settlement_utr"] || "",
        settled_at:
          row["Settled At"] || row["Settled at"] || row["settled_at"] || "",
        settled_by:
          row["Settled By"] || row["Settled by"] || row["settled_by"] || "",
      };

      results.push(mapped);
    })
    .on("end", async () => {
      try {
        if (results.length === 0) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: "CSV seems empty or invalid" });
        }

        await RazorpaySettlement.insertMany(results);
        fs.unlink(req.file.path, () => {});
        res.json({ message: "Upload successful", inserted: results.length });
      } catch (error) {
        console.error("DB Save Error:", error);
        fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: "Failed to save data" });
      }
    })
    .on("error", (err) => {
      console.error("CSV Parse Error:", err);
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: "Failed to parse CSV" });
    });
});

// ===================== GET PAGINATED DATA =====================
router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const skip = (page - 1) * limit;

  try {
    const [data, total] = await Promise.all([
      RazorpaySettlement.find()
        .skip(skip)
        .limit(limit)
        .sort({ uploadDate: -1 }),
      RazorpaySettlement.countDocuments(),
    ]);

    res.json({
      data,
      page,
      totalPages: Math.ceil(total / limit),
      totalRecords: total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

// ===================== SAMPLE CSV DOWNLOAD =====================
router.get("/sample", (req, res) => {
  const headerRow =
    "Upload Date,Transaction Entity,Entity ID,Amount,Currency,Fee,Tax,Debit,Credit,Payment Method,Card Type,Issuer Name,Created At,Order ID,Settlemet Id,Settlement UTR,Settled At,Settled By\n";

  const exampleRow =
    `${new Date().toISOString()},payment,pay_123ABC,1000,INR,20,3.6,0,1000,UPI,,HDFC Bank,2025-11-13T10:00:00Z,order_12345,settle_98765,UTR123456789,2025-11-14T12:00:00Z,Razorpay\n`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="razorpay_sample.csv"'
  );
  res.send(headerRow + exampleRow);
});

module.exports = router;
