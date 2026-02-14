const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const Axis3361Txn = require("../models/Axis3361Txn");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-axis-3361"),
});

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id || "");
}

// dd/mm/yyyy, ISO, dd-MMM-yy (01-Apr-23)
function parseDate(value) {
  if (!value) return null;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

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

  // dd-MMM-yy / dd-MMM-yyyy
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

// tolerant numeric parse (commas/spaces/CR/DR)
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
router.get("/axis-3361", async (req, res) => {
  try {
    let { page = 1, limit = 50, q, dateMin, dateMax, branchName, amountMin, amountMax } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 50;
    if (page < 1) page = 1;
    if (limit < 1) limit = 50;

    const skip = (page - 1) * limit;

    const query = {};

    // Text search across key fields
    if (q && String(q).trim()) {
      const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [
        { particulars: rx },
        { chqNo: rx },
        { remark: rx },
        { branchName: rx },
        { drCr: rx },
      ];
    }

    // Branch filter
    if (branchName && String(branchName).trim()) {
      const safe = String(branchName).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.branchName = new RegExp(safe, "i");
    }

    // Date range on tranDate
    if (dateMin || dateMax) {
      const dMin = dateMin ? parseDate(dateMin) : null;
      const dMax = dateMax ? parseDate(dateMax) : null;
      query.tranDate = {};
      if (dMin) query.tranDate.$gte = dMin;
      if (dMax) query.tranDate.$lte = dMax;
      if (!Object.keys(query.tranDate).length) delete query.tranDate;
    }

    // Amount range on amount
    const minN = parseNumQuery(amountMin);
    const maxN = parseNumQuery(amountMax);
    if (minN != null || maxN != null) {
      query.amount = {};
      if (minN != null) query.amount.$gte = minN;
      if (maxN != null) query.amount.$lte = maxN;
      if (!Object.keys(query.amount).length) delete query.amount;
    }

    const [total, txns] = await Promise.all([
      Axis3361Txn.countDocuments(query),
      Axis3361Txn.find(query)
        .sort({ tranDate: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.json({ success: true, data: txns, total, page, limit });
  } catch (err) {
    console.error("Error fetching Axis 3361 txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// PUT rowColor (partial update)
router.put("/axis-3361/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const update = {};
    if (req.body?.rowColor !== undefined) update.rowColor = String(req.body.rowColor || "");

    const doc = await Axis3361Txn.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("Error updating Axis 3361 txn:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Upload CSV
router.post("/axis-3361/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "CSV file is required" });
  }

  const filePath = req.file.path;

  try {
    const rows = await parseCsvFile(filePath);

    await Axis3361Txn.deleteMany({});

    // helper to read multiple possible header variants
    const pick = (row, keys) => {
      for (const k of keys) {
        if (row[k] !== undefined) return row[k];
      }
      return "";
    };

    const docs = rows.map((row) => ({
      tranDate: parseDate(pick(row, ["Tran Date", "TranDate", "Transaction Date", "TransactionDate"])),
      valueDate: parseDate(pick(row, ["Value Date", "ValueDate"])),
      chqNo: pick(row, ["CHQNO", "CHQ No", "Cheque No", "ChequeNo"]) || "",
      particulars: pick(row, ["Transaction Particulars", "Particulars", "Narration"]) || "",
      amount: toNumberSafe(pick(row, ["Amount(INR)", "Amount (INR)", "Amount", "Amount INR"])),
      drCr: pick(row, ["DR|CR", "DR/CR", "DrCr", "DRCR"]) || "",
      balance: toNumberSafe(pick(row, ["Balance(INR)", "Balance (INR)", "Balance"])),
      branchName: pick(row, ["Branch Name", "BranchName"]) || "",
      remark: pick(row, ["Remark", "Remarks"]) || "",
      rowColor: "",
    }));

    if (docs.length) await Axis3361Txn.insertMany(docs);

    fs.unlink(filePath, () => {});
    res.json({ success: true, message: "CSV uploaded and saved successfully", count: docs.length });
  } catch (err) {
    console.error("CSV upload error (Axis 3361):", err);
    res.status(500).json({ success: false, message: "Error processing CSV" });
  }
});

module.exports = router;
