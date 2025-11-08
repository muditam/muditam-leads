const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const Axis3361Txn = require("../models/Axis3361Txn");

// -------- Multer setup --------
const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-axis-3361"),
});

// -------- Helper: parse date safely (supports DD/MM/YYYY, etc.) --------
function parseDate(value) {
  if (!value) return null;
  const d1 = new Date(value);
  if (!isNaN(d1.getTime())) return d1;

  const parts = String(value).split("/");
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts.map((v) => parseInt(v, 10));
    if (yyyy && mm && dd) {
      return new Date(yyyy, mm - 1, dd);
    }
  }
  return null;
}

// -------- Helper: safe number parsing --------
function toNumberSafe(value) {
  if (value === undefined || value === null) return 0;

  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned.toUpperCase() === "NA") return 0;

  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

// -------- GET: list transactions with pagination --------
router.get("/axis-3361", async (req, res) => {
  try {
    let { page = 1, limit = 50 } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 50;
    if (page < 1) page = 1;
    if (limit < 1) limit = 50;

    const skip = (page - 1) * limit;

    const [total, txns] = await Promise.all([
      Axis3361Txn.countDocuments({}),
      Axis3361Txn.find()
        .sort({ tranDate: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      success: true,
      data: txns,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("Error fetching Axis 3361 txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------- POST: upload CSV --------
router.post(
  "/axis-3361/upload",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "CSV file is required" });
    }

    const filePath = req.file.path;
    const rows = [];

    try {
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (row) => rows.push(row))
          .on("end", resolve)
          .on("error", reject);
      });

      // optional: clear old data
      await Axis3361Txn.deleteMany({});

      const docs = rows.map((row) => ({
        tranDate: parseDate(row["Tran Date"]),
        valueDate: parseDate(row["Value Date"]),
        chqNo: row["CHQNO"] || "",
        particulars: row["Transaction Particulars"] || "",
        amount: toNumberSafe(row["Amount(INR)"]),
        drCr: row["DR|CR"] || "",
        balance: toNumberSafe(row["Balance(INR)"]),
        branchName: row["Branch Name"] || "",
        remark: row["Remark"] || "",
      }));

      if (docs.length) {
        await Axis3361Txn.insertMany(docs);
      }

      fs.unlink(filePath, () => {});

      res.json({
        success: true,
        message: "CSV uploaded and saved successfully",
        count: docs.length,
      });
    } catch (err) {
      console.error("CSV upload error (Axis 3361):", err);
      res.status(500).json({
        success: false,
        message: "Error processing CSV",
      });
    }
  }
);

module.exports = router;
