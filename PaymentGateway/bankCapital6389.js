const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const Capital6389Txn = require("../models/Capital6389Txn");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-capital-6389"),
});

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id || "");
}

function parseDate(value) {
  if (!value) return null;

  // already a Date
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // try native parse
  const d1 = new Date(value);
  if (!Number.isNaN(d1.getTime())) return d1;

  const s = String(value).trim();
  if (!s) return null;

  // dd/mm/yyyy
  const parts = s.split("/");
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts.map((v) => parseInt(v, 10));
    if (yyyy && mm && dd) return new Date(yyyy, mm - 1, dd);
  }

  // dd-MMM-yy (01-Apr-23) / dd-MMM-yyyy
  const m2 = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (m2) {
    let [_, dd, mon, yyyy] = m2;
    dd = Number(dd);
    const monKey = String(mon).slice(0, 3).toLowerCase();
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const mmIdx = months[monKey];
    if (mmIdx === undefined) return null;

    yyyy = String(yyyy);
    const yNum = Number(
      yyyy.length === 2 ? (Number(yyyy) >= 70 ? "19" + yyyy : "20" + yyyy) : yyyy
    );
    const d = new Date(yNum, mmIdx, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function parseNumQuery(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// tolerant number parsing
function toNumberSafe(value) {
  if (value === undefined || value === null) return null;

  let cleaned = String(value)
    .replace(/,/g, "")
    .replace(/\s*(CR|DR)$/i, "")
    .trim();

  if (!cleaned || cleaned === "-" || cleaned.toUpperCase() === "NA") return null;

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
          mapHeaders: ({ header }) => String(header || "").replace(/^\uFEFF/, "").trim(),
        })
      )
      .on("data", (row) => rows.push(row))
      .on("end", resolve)
      .on("error", reject);
  });

  return rows;
}

// GET with filters
router.get("/capital-6389", async (req, res) => {
  try {
    let { page = 1, limit = 50, q, dateMin, dateMax, branchCode, amountMin, amountMax } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 50;
    if (page < 1) page = 1;
    if (limit < 1) limit = 50;

    const skip = (page - 1) * limit;

    const query = {};

    // text search
    if (q && String(q).trim()) {
      const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [
        { description: rx },
        { refNo: rx },
        { remarks: rx },
        { branchCode: rx },
      ];
    }

    // branch filter
    if (branchCode && String(branchCode).trim()) {
      const safe = String(branchCode).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.branchCode = new RegExp(safe, "i");
    }

    // date range on txnDate
    if (dateMin || dateMax) {
      const dMin = dateMin ? parseDate(dateMin) : null;
      const dMax = dateMax ? parseDate(dateMax) : null;
      query.txnDate = {};
      if (dMin) query.txnDate.$gte = dMin;
      if (dMax) query.txnDate.$lte = dMax;
      if (!Object.keys(query.txnDate).length) delete query.txnDate;
    }

    // amount range on either debit or credit
    const minN = parseNumQuery(amountMin);
    const maxN = parseNumQuery(amountMax);
    if (minN != null || maxN != null) {
      const range = {};
      if (minN != null) range.$gte = minN;
      if (maxN != null) range.$lte = maxN;

      query.$and = (query.$and || []).concat([
        {
          $or: [{ debit: range }, { credit: range }],
        },
      ]);
    }

    const [total, txns] = await Promise.all([
      Capital6389Txn.countDocuments(query),
      Capital6389Txn.find(query)
        .sort({ txnDate: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.json({ success: true, data: txns, total, page, limit });
  } catch (err) {
    console.error("Error fetching Capital 6389 txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT rowColor (and future-safe for partial updates)
router.put("/capital-6389/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const update = {};
    if (req.body?.rowColor !== undefined) update.rowColor = String(req.body.rowColor || "");

    const doc = await Capital6389Txn.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("Error updating txn:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/capital-6389/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "CSV file is required" });
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
      rowColor: "",
    }));

    if (docs.length) await Capital6389Txn.insertMany(docs);

    fs.unlink(filePath, () => {});
    res.json({ success: true, message: "CSV uploaded and saved successfully", count: docs.length });
  } catch (err) {
    console.error("CSV upload error:", err);
    res.status(500).json({ success: false, message: "Error processing CSV" });
  }
});

module.exports = router;
