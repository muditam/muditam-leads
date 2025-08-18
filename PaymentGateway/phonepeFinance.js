const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const PhonePeSettlement = require("../models/PhonePeSettlement");

const upload = multer({ dest: "uploads/" });

// Helper function to safely parse float
const safeParseFloat = (value) => {
  const num = parseFloat((value || "").toString().replace(/,/g, "").trim());
  return isNaN(num) ? 0 : num;
};

// Upload and save CSV
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const records = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        records.push({
          uploadDate: new Date(),
          merchantId: data["Merchant Id"],
          transactionType: data["Transaction Type"],
          merchantOrderId: data["Merchant Order Id"],
          merchantReferenceId: data["Merchant Reference Id"],
          phonePeReferenceId: data["PhonePe Reference Id"],
          phonePeTransactionReferenceId: data["PhonePe Transaction Reference Id"],
          phonePeAttemptReferenceId: data["PhonePe Attempt Reference Id"],
          transactionUTR: data["Transaction UTR"],
          totalTransactionAmount: safeParseFloat(data["Total Transaction Amount"]),
          transactionDate: data["Transaction Date"],
          transactionStatus: data["Transaction Status"],
          upiAmount: safeParseFloat(data["UPI Amount"]),
          walletAmount: safeParseFloat(data["Wallet Amount"]),
          creditCardAmount: safeParseFloat(data["Credit card Amount"]),
          debitCardAmount: safeParseFloat(data["Debit card Amount"]),
          externalWalletAmount: safeParseFloat(data["External Wallet Amount"]),
          egvAmount: safeParseFloat(data["EGV Amount"]),
          storeId: data["Store Id"],
          terminalId: data["Terminal Id"],
          storeName: data["Store Name"],
          terminalName: data["Terminal Name"],
          errorCode: data["Error Code"],
          detailedErrorCode: data["Detailed Error Code"],
          errorDescription: data["Error Description"],
          errorSource: data["Error Source"],
          errorStage: data["Error Stage"],
        });
      })
      .on("end", async () => {
        try {
          await PhonePeSettlement.insertMany(records);
          fs.unlinkSync(filePath);
          res.json({ message: "Upload successful", inserted: records.length });
        } catch (err) {
          console.error("DB insert error:", err);
          res.status(500).json({ error: "Failed to save records to DB." });
        }
      })
      .on("error", (err) => {
        console.error("CSV parsing error:", err);
        res.status(500).json({ error: "Error reading the CSV file." });
      });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to upload CSV." });
  }
});

// Paginated fetch
router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const totalCount = await PhonePeSettlement.countDocuments();
    const data = await PhonePeSettlement.find()
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ data, page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch paginated data" });
  }
});

module.exports = router;
