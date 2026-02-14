const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const Cc1101Txn = require("../models/Cc1101Txn");

// -------- Multer setup --------
const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-cc-1101"),
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

  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    dd = Number(dd);
    mm = Number(mm);
    yyyy = String(yyyy);
    const yNum = Number(
      yyyy.length === 2 ? (Number(yyyy) >= 70 ? "19" + yyyy : "20" + yyyy) : yyyy
    );
    const d = new Date(yNum, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // dd-MMM-yy / dd-MMM-yyyy
  const m2 = s.match(/^(\d{1,2})[\/\- ]([A-Za-z]{3,})[\/\- ](\d{2,4})$/);
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

// -------- Helper: safe number parsing --------
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

function parseNumQuery(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).trim().replace(/,/g, ""));
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

// -------- GET: list transactions with pagination + filters --------
router.get("/cc-1101", async (req, res) => {
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

    // date range on `date`
    if (dateMin || dateMax) {
      const dMin = dateMin ? parseDate(dateMin) : null;
      const dMax = dateMax ? parseDate(dateMax) : null;
      query.date = {};
      if (dMin) query.date.$gte = dMin;
      if (dMax) query.date.$lte = dMax;
      if (!Object.keys(query.date).length) delete query.date;
    }

    // amount range applies to either debit or credit
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
      Cc1101Txn.countDocuments(query),
      Cc1101Txn.find(query).sort({ date: 1, createdAt: 1 }).skip(skip).limit(limit).lean(),
    ]);

    res.json({ success: true, data: txns, total, page, limit });
  } catch (err) {
    console.error("Error fetching CC 1101 txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------- PUT: update rowColor (partial) --------
router.put("/cc-1101/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const update = {};
    if (req.body?.rowColor !== undefined) update.rowColor = String(req.body.rowColor || "");

    const doc = await Cc1101Txn.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("Error updating CC 1101 txn:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------- POST: upload CSV (tolerant headers + separator detect) --------
router.post("/cc-1101/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "CSV file is required" });
  }

  const filePath = req.file.path;

  try {
    const rows = await parseCsvFile(filePath);

    await Cc1101Txn.deleteMany({});

    const pick = (row, keys) => {
      for (const k of keys) {
        if (row[k] !== undefined) return row[k];
      }
      return "";
    };

    const docs = rows.map((row) => ({
      date: parseDate(pick(row, ["Date", "Txn Date", "Transaction Date"])),
      valueDate: parseDate(pick(row, ["Value Date", "ValueDate"])),
      description: pick(row, ["Description", "Narration"]) || "",
      refNo: pick(row, ["Ref No./Cheque No.", "Ref No", "Cheque No.", "Ref"]) || "",
      branchCode: pick(row, ["Branch Code", "BranchCode"]) || "",
      debit: toNumberSafe(pick(row, ["Debit", "Debit (Exp)", "Dr"])),
      credit: toNumberSafe(pick(row, ["Credit", "Credit (income)", "Cr"])),
      balance: toNumberSafe(pick(row, ["Balance", "Closing Balance"])),
      remarks: pick(row, ["Remarks", "Remark"]) || "",
      rowColor: "",
    }));

    if (docs.length) await Cc1101Txn.insertMany(docs);

    fs.unlink(filePath, () => {});
    res.json({ success: true, message: "CSV uploaded and saved successfully", count: docs.length });
  } catch (err) {
    console.error("CSV upload error (CC 1101):", err);
    res.status(500).json({ success: false, message: "Error processing CSV" });
  }
});

module.exports = router;
