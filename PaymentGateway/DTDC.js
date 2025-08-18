const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const DtdcSettlement = require("../models/DtdcSettlement");

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
              .replace(/\uFEFF/g, "")     // strip BOM
              .replace(/\s+/g, " ")       // normalize multiple spaces
              .trim(),
          separator: ",",
          skipLines: 0,
        })
      )
      .on("data", (row) => {
        // Optional: uncomment to inspect raw keys when debugging
        // if (!row["CN Number"]) console.log("HEADERS:", Object.keys(row));

        const cnNumber = pick(row, ["CN Number", "CN No", "CNNumber"]);
        const customerReferenceNumber = pick(row, ["Customer Reference Number", "Customer Ref No", "CRN"]);
        const bookingDate = pick(row, ["Booking Date"]);
        const deliveryDate = pick(row, ["Delivery Date"]);
        const codAmount = parseFloat(pick(row, ["COD Amount"])) || 0;
        const remittedAmount = parseFloat(pick(row, ["Remitted Amount"])) || 0;
        const remittanceStatus = pick(row, ["Remittance Status"]);
        const utrNumber = pick(row, ["UTR Number", "UTR No"]);
        const remittanceDate = pick(row, ["Remittance Date"]);

        records.push({
          uploadDate: new Date(),
          cnNumber,
          customerReferenceNumber,
          bookingDate,
          deliveryDate,
          codAmount,
          remittedAmount,
          remittanceStatus,
          utrNumber,
          remittanceDate,
        });
      })
      .on("end", async () => {
        try {
          await DtdcSettlement.insertMany(records);
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
    console.error("DTDC upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

router.get("/data", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  try {
    const totalCount = await DtdcSettlement.countDocuments();
    const data = await DtdcSettlement.find()
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ data, page, limit, totalCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch DTDC data" });
  }
});

module.exports = router;
