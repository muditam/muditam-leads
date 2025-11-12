const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const Capital6389Txn = require("../models/Capital6389Txn");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-capital-6389"),
});

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

// more tolerant number parsing (handles commas, DR/CR, spaces, etc.)
function toNumberSafe(value) {
  if (value === undefined || value === null) return null;

  let cleaned = String(value)
    .replace(/,/g, "")
    .replace(/\s*(CR|DR)$/i, "") // remove trailing CR / DR if present
    .trim();

  if (!cleaned || cleaned === "-" || cleaned.toUpperCase() === "NA") {
    return null;
  }

  // keep only digits, minus and dot
  cleaned = cleaned.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

function detectSeparator(filePath) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { encoding: "utf8" });
    rs.on("data", (chunk) => {
      rs.destroy();
      const firstLine = chunk.split(/\r?\n/)[0] || "";
      if (firstLine.includes("\t")) return resolve("\t");
      if (firstLine.includes(";")) return resolve(";");
      return resolve(",");
    });
    rs.on("error", reject);
  });
}

async function parseCsvFile(filePath) {
  const separator = await detectSeparator(filePath);
  const rows = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(
        csv({
          separator,
          mapHeaders: ({ header }) =>
            header.replace(/^\uFEFF/, "").trim(),
        })
      )
      .on("data", (row) => {
        if (rows.length === 0) {
           
        }
        rows.push(row);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  return rows;
}

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

    try {
      const rows = await parseCsvFile(filePath);

      await Capital6389Txn.deleteMany({});

      const docs = rows.map((row) => ({
        txnDate: parseDate(row["Txn Date"]),
        valueDate: parseDate(row["Value Date"]),
        description: row["Description"] || "",
        refNo: row["Ref No./Cheque No."] || "",
        branchCode: row["Branch Code"] || "",
        debit: toNumberSafe(row["Debit"]),
        credit: toNumberSafe(row["Credit"]),
        balance: toNumberSafe(row["Balance"]),
        remarks: row["Remarks"] || "",
      }));

      if (docs.length) {
        await Capital6389Txn.insertMany(docs);
      }

      fs.unlink(filePath, () => {});

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
