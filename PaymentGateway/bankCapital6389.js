const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const Capital6389Txn = require("../models/Capital6389Txn");

// -------- Multer setup --------
const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-capital-6389"),
});

// -------- Helper: parse date safely (supports DD/MM/YYYY, etc.) --------
function parseDate(value) {
  if (!value) return null;
  // try native
  const d1 = new Date(value);
  if (!isNaN(d1.getTime())) return d1;

  // try DD/MM/YYYY
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

  // treat blanks, dashes etc as zero
  if (!cleaned || cleaned === "-" || cleaned.toUpperCase() === "NA") {
    return 0;
  }

  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

// -------- GET: list transactions with pagination --------
router.get("/capital-6389", async (req, res) => {
  try {
    let { page = 1, limit = 50 } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 50;
    if (page < 1) page = 1;
    if (limit < 1) limit = 50;

    const skip = (page - 1) * limit;

    const [total, txns] = await Promise.all([
      Capital6389Txn.countDocuments({}),
      Capital6389Txn.find()
        .sort({ txnDate: 1, createdAt: 1 })
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
    console.error("Error fetching Capital 6389 txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------- POST: upload CSV --------
router.post(
  "/capital-6389/upload",
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
          .on("data", (row) => {
            rows.push(row);
          })
          .on("end", resolve)
          .on("error", reject);
      });

      // optional: clear existing txns before re-upload
      await Capital6389Txn.deleteMany({});

      const docs = rows.map((row) => {
        return {
          txnDate: parseDate(row["Txn Date"]),
          valueDate: parseDate(row["Value Date"]),
          description: row["Description"] || "",
          refNo: row["Ref No./Cheque No."] || "",
          branchCode: row["Branch Code"] || "",
          debit: toNumberSafe(row["Debit"]),
          credit: toNumberSafe(row["Credit"]),
          balance: toNumberSafe(row["Balance"]),
          remarks: row["Remarks"] || "",
        };
      });

      if (docs.length) {
        await Capital6389Txn.insertMany(docs);
      }

      fs.unlink(filePath, () => {}); // clean temp file (ignore errors)

      res.json({
        success: true,
        message: "CSV uploaded and saved successfully",
        count: docs.length,
      });
    } catch (err) {
      console.error("CSV upload error:", err);
      res.status(500).json({
        success: false,
        message: "Error processing CSV",
      });
    }
  }
);

module.exports = router;
