const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const mongoose = require("mongoose");

const KotakBankTxn = require("../models/KotakBankTxn");

// ---------- Multer ----------
const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "bank-kotak"),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id || "");
}

// ---------- Helpers ----------
function parseDate(value) {
  if (!value) return null;

  // If already a Date-like
  const d1 = new Date(value);
  if (!Number.isNaN(d1.getTime())) return d1;

  // dd/mm/yyyy
  const parts = String(value).trim().split("/");
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts.map((v) => parseInt(v, 10));
    if (yyyy && mm && dd) return new Date(yyyy, mm - 1, dd);
  }
  return null;
}

// Handles commas, spaces, CR/DR, parentheses negatives
function parseNum(value) {
  if (value === undefined || value === null) return null;

  let s = String(value).trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;

  // remove trailing CR/DR if present
  s = s.replace(/\s*(CR|DR)$/i, "").trim();

  // parentheses negative
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // remove commas/spaces and non-number except dot/minus
  s = s.replace(/,/g, "").replace(/\s+/g, "").replace(/[^0-9.-]/g, "");
  if (!s) return null;

  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

function parseNumQuery(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? null : n;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Detect delimiter: tab / semicolon / comma
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

// ---------- GET /kotak-bank (pagination + filters) ----------
router.get("/kotak-bank", async (req, res) => {
  try {
    let { page = 1, limit = 250 } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 250;
    if (page < 1) page = 1;
    if (limit < 1) limit = 250;
    limit = Math.min(limit, 500);

    const skip = (page - 1) * limit;

    const {
      q,
      year, // 2023/2024/2025/2026
      dateMin,
      dateMax,
      amountMin,
      amountMax,
      drcr, // optional: DR / CR
    } = req.query;

    const query = {};

    // Text search
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [{ description: rx }, { chqRefNo: rx }, { remarks: rx }];
    }

    // Year filter (applies to valueDate; if missing, falls back to transactionDate via $or)
    if (year && /^\d{4}$/.test(String(year))) {
      const y = Number(year);
      const start = new Date(y, 0, 1);
      const end = new Date(y, 11, 31, 23, 59, 59, 999);

      query.$and = (query.$and || []).concat([
        {
          $or: [
            { valueDate: { $gte: start, $lte: end } },
            { valueDate: null, transactionDate: { $gte: start, $lte: end } },
          ],
        },
      ]);
    }

    // Date range on valueDate (ledger date)
    if (dateMin || dateMax) {
      query.valueDate = query.valueDate || {};
      if (dateMin) {
        const dMin = parseDate(dateMin);
        if (dMin) query.valueDate.$gte = dMin;
      }
      if (dateMax) {
        const dMax = parseDate(dateMax);
        if (dMax) query.valueDate.$lte = dMax;
      }
      if (!Object.keys(query.valueDate).length) delete query.valueDate;
    }

    // Amount range on amount
    const aMin = parseNumQuery(amountMin);
    const aMax = parseNumQuery(amountMax);
    if (aMin != null || aMax != null) {
      query.amount = {};
      if (aMin != null) query.amount.$gte = aMin;
      if (aMax != null) query.amount.$lte = aMax;
      if (!Object.keys(query.amount).length) delete query.amount;
    }

    // DR/CR filter (matches either amountDrCr or balanceDrCr)
    if (drcr && String(drcr).trim()) {
      const v = String(drcr).trim().toUpperCase();
      query.$and = (query.$and || []).concat([
        { $or: [{ amountDrCr: v }, { balanceDrCr: v }] },
      ]);
    }

    const [total, items] = await Promise.all([
      KotakBankTxn.countDocuments(query),
      KotakBankTxn.find(query)
        .sort({ valueDate: -1, transactionDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      success: true,
      data: items,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("GET /kotak-bank error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// ---------- PUT /kotak-bank/:id (rowColor update or full update) ----------
router.put("/kotak-bank/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid id" });

    // Keep it safe: allow only rowColor + remarks (optional)
    const payload = {
      rowColor: typeof req.body.rowColor === "string" ? req.body.rowColor.trim() : undefined,
      remarks: typeof req.body.remarks === "string" ? req.body.remarks : undefined,
    };

    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const updated = await KotakBankTxn.findByIdAndUpdate(id, { $set: payload }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });

    return res.json({ success: true, item: updated });
  } catch (err) {
    console.error("PUT /kotak-bank/:id error:", err);
    return res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// ---------- POST /kotak-bank/upload (CSV) ----------
router.post("/kotak-bank/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "CSV file is required" });
  }

  const filePath = req.file.path;

  try {
    const separator = await detectSeparator(filePath);
    const rows = [];

    // handle duplicate headers: "Dr / Cr" appears twice
    const seen = {};
    const mapHeaders = ({ header }) => {
      const clean = String(header || "").replace(/^\uFEFF/, "").trim();
      const key = clean.toLowerCase();
      seen[key] = (seen[key] || 0) + 1;
      // if duplicated, append __2 etc.
      return seen[key] > 1 ? `${clean}__${seen[key]}` : clean;
    };

    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv({ separator, mapHeaders }))
        .on("data", (row) => rows.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    // clear old data on re-upload (same as your other bank routes)
    await KotakBankTxn.deleteMany({});

    const pick = (row, keys) => {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") return row[k];
      }
      return "";
    };

    const docs = rows.map((r) => {
      const drcr1 = pick(r, ["Dr / Cr", "DR / CR", "DR|CR", "Dr/Cr", "Dr / Cr__1"]);
      const drcr2 = pick(r, ["Dr / Cr__2", "DR / CR__2", "DR|CR__2", "Dr/Cr__2"]);

      return {
        slNo: (() => {
          const raw = pick(r, ["Sl. No.", "Sl No", "S.No.", "S No"]);
          const n = Number(String(raw).replace(/[^\d]/g, ""));
          return Number.isNaN(n) ? null : n;
        })(),

        transactionDate: parseDate(pick(r, ["Transaction Date", "Txn Date", "Tran Date"])),
        valueDate: parseDate(pick(r, ["Value Date"])),

        description: String(pick(r, ["Description"])).trim(),
        chqRefNo: String(pick(r, ["Chq / Ref No.", "Chq/Ref No.", "Chq Ref No", "Chq / Ref No"])).trim(),

        amount: parseNum(pick(r, ["Amount"])),
        amountDrCr: String(drcr1 || "").trim().toUpperCase(),

        balance: parseNum(pick(r, ["Balance"])),
        balanceDrCr: String(drcr2 || "").trim().toUpperCase(),

        remarks: String(pick(r, ["Remarks", "Remark"])).trim(),
        rowColor: "",
      };
    });

    // insert
    if (docs.length) await KotakBankTxn.insertMany(docs);

    fs.unlink(filePath, () => {});

    return res.json({
      success: true,
      message: "CSV uploaded and saved successfully",
      count: docs.length,
    });
  } catch (err) {
    console.error("CSV upload error (Kotak):", err);
    fs.unlink(filePath, () => {});
    return res.status(500).json({ success: false, message: "Error processing CSV" });
  }
});

module.exports = router;
