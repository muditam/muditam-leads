const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const BluedartSettlement = require("../models/BluedartSettlement");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// tiny helper to read from variant header names (safer)
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};

router.post("/upload", upload.single("file"), async (req, res) => {
  const records = [];
  try {
    fs.createReadStream(req.file.path)
      .pipe(
        csv({
          // Normalize headers: remove BOM, trim, collapse spaces
          mapHeaders: ({ header }) =>
            header
              .replace(/\uFEFF/g, "")
              .replace(/\s+/g, " ")
              .trim(),
          separator: ",",
        })
      )
      .on("data", (row) => {
        // Expecting: AWB NO, DPUDATE, PROCESS_DT, ORDER ID, PORTAL NAME, NCUSTPAYAMT, UTR, SETTLED DATE
        const awbNo = pick(row, ["AWB NO", "CRTOAWBNO", "AWB"]);
        const dpuDate = pick(row, ["DPUDATE", "DPU DATE"]);
        const processDate = pick(row, ["PROCESS_DT", "PROCESS DT"]);
        const orderId = pick(row, ["ORDER ID", "Order ID"]);
        const portalName = pick(row, ["PORTAL NAME", "PortalName", "PORTAL"]);
        const amountRaw = pick(row, ["NCUSTPAYAMT", "Customer Pay Amount"]);
        const customerPayAmt = amountRaw
          ? parseFloat(amountRaw.toString().replace(/[,₹ ]/g, ""))
          : 0;
        const utr = pick(row, ["UTR", "UTR NO"]);
        const settledDate = pick(row, ["SETTLED DATE", "Settled Date"]);

        records.push({
          uploadDate: new Date(),
          awbNo,
          dpuDate,
          processDate,
          orderId,
          portalName,
          customerPayAmt: isNaN(customerPayAmt) ? 0 : customerPayAmt,
          utr,
          settledDate,
        });
      })
      .on("end", async () => {
        try {
          if (!records.length) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: "No rows parsed from CSV." });
          }
          await BluedartSettlement.insertMany(records);
          fs.unlinkSync(req.file.path);
          res.json({ message: "Upload successful", inserted: records.length });
        } catch (err) {
          console.error("DB insert error:", err);
          res.status(500).json({ error: "Failed to insert to DB" });
        }
      })
      .on("error", (e) => {
        console.error("CSV parse error:", e);
        res.status(400).json({ error: "Invalid CSV" });
      });
  } catch (error) {
    console.error("Bluedart upload error:", error);
    res.status(500).json({ error: "Failed to upload data" });
  }
});

router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const totalCount = await BluedartSettlement.countDocuments();
    const data = await BluedartSettlement.find()
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ data, page, limit, totalCount });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

module.exports = router;
