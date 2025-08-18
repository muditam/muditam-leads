const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const EasebuzzTransaction = require("../models/EasebuzzTransaction");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Helper: resilient field getter (handles header variants)
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};
// Helper: parse numbers like "₹1,234.56", " 1,234 " safely
const num = (v) => {
  if (v == null) return 0;
  const clean = String(v).replace(/[,₹\s]/g, "");
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
};

router.post("/upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;
  const rows = [];

  try {
    fs.createReadStream(filePath)
      .pipe(
        csv({ 
          mapHeaders: ({ header }) =>
            header
              .replace(/\uFEFF/g, "")
              .replace(/\s+/g, " ")
              .trim(),
          separator: ",",
        })
      )
      .on("data", (data) => { 

        const serialNo = pick(data, ["S. No.", "S.No.", "S No", "S No."]);
        const transactionType = pick(data, ["Transaction Type"]);
        const paymentId = pick(data, ["Payment Id", "Payment ID"]);
        const orderId = pick(data, ["Order Id", "Order ID"]);
        const amount = num(pick(data, ["Amount"]));
        const currency = pick(data, ["Currency"]);
        const tax = num(pick(data, ["Tax"]));
        const fee = num(pick(data, ["Fee"]));
        const additionalFees = num(pick(data, ["Additional Fees"]));
        const additionalTax = num(pick(data, ["Additional Tax"]));
        const debit = num(pick(data, ["Debit"]));
        const gokwikDeduction = num(pick(data, ["gokwik Deduction", "GoKwik Deduction", "Gokwik Deduction"]));
        const credit = num(pick(data, ["Credit"]));
        const paymentMethod = pick(data, ["Payment Method"]);
        const transactionDate = pick(data, ["Transaction Date"]);
        const transactionRRN = pick(data, ["Transaction RRN"]);
        const merchantOrderId = pick(data, ["Merchant Order Id", "Merchant Order ID"]);
        const shopifyOrderId = pick(data, ["Shopify Order Id", "Shopify Order ID"]);
        const shopifyTransactionId = pick(data, ["Shopify Transaction Id", "Shopify Transaction ID"]);
        const settlementUTR = pick(data, ["Settlement UTR", "UTR Number", "UTR"]);
        const settlementDate = pick(data, ["Settlement Date"]);
        const settledBy = pick(data, ["Settled By"]);
        const paymentMode = pick(data, ["Payment Mode"]);
        const bankCode = pick(data, ["Bank Code"]);
        const cardNetwork = pick(data, ["Card Network"]);

        rows.push({
          uploadDate: new Date(),
          serialNo,
          transactionType,
          paymentId,
          orderId,
          amount,
          currency,
          tax,
          fee,
          additionalFees,
          additionalTax,
          debit,
          gokwikDeduction,
          credit,
          paymentMethod,
          transactionDate,
          transactionRRN,
          merchantOrderId,
          shopifyOrderId,
          shopifyTransactionId,
          settlementUTR,
          settlementDate,
          settledBy,
          paymentMode,
          bankCode,
          cardNetwork,
        });
      })
      .on("end", async () => {
        try {
          if (!rows.length) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ error: "No rows parsed from CSV." });
          }
          await EasebuzzTransaction.insertMany(rows);
          fs.unlinkSync(filePath);
          res.json({ message: "Upload successful", inserted: rows.length });
        } catch (e) {
          console.error("DB insert error:", e);
          res.status(500).json({ error: "Failed to insert rows" });
        }
      })
      .on("error", (e) => {
        console.error("CSV parse error:", e);
        res.status(400).json({ error: "Invalid CSV" });
      });
  } catch (err) {
    console.error("Easebuzz upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Paginated Fetch
router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const [data, totalCount] = await Promise.all([
      EasebuzzTransaction.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      EasebuzzTransaction.countDocuments(),
    ]);

    res.json({
      data,
      page,
      limit,
      totalCount,
    });
  } catch (err) {
    console.error("Fetch Easebuzz error:", err);
    res.status(500).json({ error: "Failed to fetch Easebuzz data" });
  }
});

module.exports = router;
