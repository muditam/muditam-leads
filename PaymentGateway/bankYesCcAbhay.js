const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");
const YesCcAbhayTxn = require("../models/YesCcAbhayTxn");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-yes-cc-abhay"),
});

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id || "");
}

function parseDate(value) {
  if (!value) return null;

  const d1 = new Date(value);
  if (!Number.isNaN(d1.getTime())) return d1;

  const s = String(value).trim();
  if (!s) return null;

  // dd/mm/yyyy or dd-mm-yyyy (also handles yyyy as 2 digits)
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

  return null;
}

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

function escapeRegex(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDrCr(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "DR" || s === "DEBIT") return "DR";
  if (s === "CR" || s === "CREDIT") return "CR";
  return s; // keep as-is if something else
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

// ✅ GET with filters
router.get("/yes-cc-abhay", async (req, res) => {
  try {
    let { page = 1, limit = 50, q, dateMin, dateMax, amountMin, amountMax, drCr } = req.query;

    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 50;
    if (page < 1) page = 1;
    if (limit < 1) limit = 50;

    const skip = (page - 1) * limit;
    const query = {};

    // search in transactionDetails/drCr/remarks
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [{ transactionDetails: rx }, { drCr: rx }, { remarks: rx }];
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

    // amount range on `amount`
    const minN = parseNumQuery(amountMin);
    const maxN = parseNumQuery(amountMax);
    if (minN != null || maxN != null) {
      query.amount = {};
      if (minN != null) query.amount.$gte = minN;
      if (maxN != null) query.amount.$lte = maxN;
      if (!Object.keys(query.amount).length) delete query.amount;
    }

    // drCr exact filter
    if (drCr && String(drCr).trim()) {
      query.drCr = normalizeDrCr(drCr);
    }

    const [total, txns] = await Promise.all([
      YesCcAbhayTxn.countDocuments(query),
      YesCcAbhayTxn.find(query)
        .sort({ date: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.json({ success: true, data: txns, total, page, limit });
  } catch (err) {
    console.error("Error fetching Yes CC Abhay txns:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ PUT rowColor
router.put("/yes-cc-abhay/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const update = {};
    if (req.body?.rowColor !== undefined) update.rowColor = String(req.body.rowColor || "");

    const doc = await YesCcAbhayTxn.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("Error updating Yes CC Abhay txn:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Upload (tolerant)
router.post("/yes-cc-abhay/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "CSV file is required" });
  }

  const filePath = req.file.path;

  try {
    const rows = await parseCsvFile(filePath);

    await YesCcAbhayTxn.deleteMany({});

    const pick = (row, keys) => {
      for (const k of keys) if (row[k] !== undefined) return row[k];
      return "";
    };

    const docs = rows.map((row) => ({
      date: parseDate(pick(row, ["Date", "Txn Date", "Transaction Date"])),
      transactionDetails: pick(row, ["Transaction Details", "Details", "Narration", "Description"]) || "",
      amount: toNumberSafe(pick(row, ["Amount (Rs.)", "Amount", "Amt"])),
      drCr: normalizeDrCr(pick(row, ["Dr/Cr", "DR/CR", "DrCr", "Type"])),
      balance: toNumberSafe(pick(row, ["Balance", "Bal", "Closing Balance"])),
      remarks: pick(row, ["Remarks", "Remark"]) || "",
      rowColor: "",
    }));

    if (docs.length) await YesCcAbhayTxn.insertMany(docs);

    fs.unlink(filePath, () => {});
    res.json({ success: true, message: "CSV uploaded and saved successfully", count: docs.length });
  } catch (err) {
    console.error("CSV upload error (Yes CC Abhay):", err);
    res.status(500).json({ success: false, message: "Error processing CSV" });
  }
});

module.exports = router;
