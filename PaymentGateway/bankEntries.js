// routes/bankEntries.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const xlsx = require("xlsx");
const mongoose = require("mongoose");

const BankEntry = require("../models/BankEntry");

// ---------- Multer (with size limits) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---------- Helpers ----------
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id || "");
}

// Parse numbers like "1,234.56", " (1,234.56) ", "1 234,56" (loosely)
function parseNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  let s = String(v).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/\s+/g, "").replace(/,/g, "");
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

// for query params (don’t interpret "" as 0)
function parseNumQuery(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? null : n;
}

// Excel serial date -> JS Date
function excelSerialToDate(serial) {
  try {
    const utc_days = Math.floor(serial - 25569);
    const utc_value = utc_days * 86400;
    const date_info = new Date(utc_value * 1000);
    const fractional_day = serial - Math.floor(serial) + 1e-7;
    let total_seconds = Math.floor(86400 * fractional_day);
    const seconds = total_seconds % 60;
    total_seconds -= seconds;
    const hours = Math.floor(total_seconds / 3600);
    const minutes = Math.floor(total_seconds / 60) % 60;
    return new Date(
      date_info.getFullYear(),
      date_info.getMonth(),
      date_info.getDate(),
      hours,
      minutes,
      seconds
    );
  } catch {
    return null;
  }
}

// dd/mm/yyyy or dd-mm-yyyy -> Date; dd-MMM-yy -> Date; ISO/other -> Date; Excel serial -> Date
function parseDate(v) {
  if (!v && v !== 0) return null;

  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v;
  }

  if (typeof v === "number") return excelSerialToDate(v);

  const s = String(v).trim();
  if (!s) return null;

  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    dd = Number(dd);
    mm = Number(mm);
    yyyy = Number(yyyy.length === 2 ? (yyyy >= 70 ? "19" + yyyy : "20" + yyyy) : yyyy);
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // dd-MMM-yy or dd-MMM-yyyy  (e.g., 01-Apr-23)
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
    const yNum = Number(yyyy.length === 2 ? (Number(yyyy) >= 70 ? "19" + yyyy : "20" + yyyy) : yyyy);
    const d = new Date(yNum, mmIdx, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ISO/other
  const d2 = new Date(s);
  return Number.isNaN(d2.getTime()) ? null : d2;
}

// Keep empty strings for strings; null for numeric empties; preserve rowColor
function sanitizePayload(b) {
  const trim = (x) => (x == null ? "" : String(x).trim());
  const numOrNull = (v) => (v === "" || v === undefined ? null : parseNum(v));

  return {
    valueDate: parseDate(b.valueDate),
    txnDate: parseDate(b.txnDate),
    description: trim(b.description),
    refNoChequeNo: trim(b.refNoChequeNo),
    branchCode: trim(b.branchCode),
    debit: numOrNull(b.debit),
    credit: numOrNull(b.credit),
    balance: numOrNull(b.balance),
    remark: trim(b.remark),
    orderIds: trim(b.orderIds),
    remarks3: trim(b.remarks3),
    rowColor: trim(b.rowColor),
  };
}

// Chunk big arrays to avoid huge single insert
async function insertInChunks(docs, size = 1000) {
  let inserted = 0;
  for (let i = 0; i < docs.length; i += size) {
    const chunk = docs.slice(i, i + size);
    const res = await BankEntry.insertMany(chunk, { ordered: false });
    inserted += res.length;
  }
  return inserted;
}

// ---------- GET /api/bank-entries (with optional filters) ----------
router.get("/api/bank-entries", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "10", 10)));
    const skip = (page - 1) * limit;

    const { q, dateMin, dateMax } = req.query;
    const amountMin = parseNumQuery(req.query.amountMin);
    const amountMax = parseNumQuery(req.query.amountMax);

    const query = {};

    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { description: rx },
        { refNoChequeNo: rx },
        { orderIds: rx },
        { remark: rx },
        { remarks3: rx },
      ];
    }

    // Date range on valueDate (ledger date)
    if (dateMin || dateMax) {
      query.valueDate = {};
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

    // Amount range applies to either debit or credit
    if (amountMin != null || amountMax != null) {
      const range = {};
      if (amountMin != null) range.$gte = amountMin;
      if (amountMax != null) range.$lte = amountMax;

      query.$and = (query.$and || []).concat([
        {
          $or: [
            Object.keys(range).length ? { debit: range } : null,
            Object.keys(range).length ? { credit: range } : null,
          ].filter(Boolean),
        },
      ]);
    }

    const [items, total] = await Promise.all([
      BankEntry.find(query).sort({ valueDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      BankEntry.countDocuments(query),
    ]);

    return res.json({
      ok: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    });
  } catch (err) {
    console.error("GET /api/bank-entries error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

// ---------- POST /api/bank-entries (create single) ----------
router.post("/api/bank-entries", async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);
    const doc = await BankEntry.create(payload);
    return res.json({ ok: true, item: doc });
  } catch (err) {
    console.error("POST /api/bank-entries error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

// ---------- PUT /api/bank-entries/:id (update single) ----------
router.put("/api/bank-entries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid id" });
    }
    const payload = sanitizePayload(req.body);
    const updated = await BankEntry.findByIdAndUpdate(id, payload, { new: true });
    if (!updated) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    return res.json({ ok: true, item: updated });
  } catch (err) {
    console.error("PUT /api/bank-entries/:id error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

// ---------- DELETE /api/bank-entries/:id ----------
router.delete("/api/bank-entries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "Invalid id" });
    }
    const found = await BankEntry.findByIdAndDelete(id);
    if (!found) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/bank-entries/:id error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

// ---------- POST /api/bank-entries/upload (Excel/CSV -> server parse) ----------
router.post("/api/bank-entries/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file provided." });

    const wb = xlsx.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];

    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows.length) return res.json({ ok: true, inserted: 0, skipped: 0 });

    const rawHeaders = rows[0].map((h) => String(h || "").trim());
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/\s/g, "");
    const H = rawHeaders.map(norm);

    // IMPORTANT: store ALL indices for duplicate headers
    const headerIdx = {};
    H.forEach((h, i) => {
      if (!headerIdx[h]) headerIdx[h] = [];
      headerIdx[h].push(i);
    });

    // pick supports choosing occurrence (0 = first, 1 = second...)
    const pick = (rowArr, alts, occurrence = 0) => {
      for (const a of alts) {
        const key = norm(a);
        const arr = headerIdx[key];
        if (arr && arr.length) {
          const idx = arr[Math.min(occurrence, arr.length - 1)];
          if (idx != null && rowArr[idx] !== undefined) return rowArr[idx];
        }
      }
      return "";
    };

    // Special-case: if file has two "Value Date" columns and no explicit txn column,
    // map 1st Value Date -> txnDate, 2nd Value Date -> valueDate (ledger)
    const valueDateIdxs = headerIdx[norm("Value Date")] || [];
    const hasTxnHeader =
      (headerIdx[norm("Transaction Date")] && headerIdx[norm("Transaction Date")].length) ||
      (headerIdx[norm("Txn Date")] && headerIdx[norm("Txn Date")].length) ||
      (headerIdx[norm("TransactionDate")] && headerIdx[norm("TransactionDate")].length) ||
      (headerIdx[norm("Value Date 2")] && headerIdx[norm("Value Date 2")].length) ||
      (headerIdx[norm("Second Value Date")] && headerIdx[norm("Second Value Date")].length);

    const docs = [];
    for (let r = 1; r < rows.length; r++) {
      const arr = rows[r];
      if (!arr || arr.length === 0) continue;

      const valueDateRaw = pick(arr, ["Value Date", "ValueDate", "Posting Date", "PostingDate"], 1); // default to 2nd if present
      const txnDateRaw =
        hasTxnHeader
          ? pick(arr, ["Value Date 2", "Txn Date", "Transaction Date", "TransactionDate", "Second Value Date"], 0)
          : (valueDateIdxs.length >= 2
              ? pick(arr, ["Value Date", "ValueDate"], 0) // 1st Value Date
              : pick(arr, ["Value Date 2", "Txn Date", "Transaction Date", "TransactionDate", "Second Value Date"], 0));

      const candidate = sanitizePayload({
        // If only one Value Date exists, valueDateRaw will just fall back to that column (occurrence clamps)
        valueDate: valueDateIdxs.length >= 2 ? valueDateRaw : pick(arr, ["Value Date", "ValueDate", "Posting Date", "PostingDate"], 0),
        txnDate: txnDateRaw,

        description: pick(arr, ["Description", "Narration"]),
        refNoChequeNo: pick(arr, ["Ref No./Cheque No.", "Ref No", "Cheque No.", "Ref", "Reference"]),
        branchCode: pick(arr, ["Branch Code", "BranchCode"]),
        debit: pick(arr, ["Debit (Exp)", "Debit", "Dr"]),
        credit: pick(arr, ["Credit (income)", "Credit", "Cr"]),
        balance: pick(arr, ["Balance", "Closing Balance"]),
        remark: pick(arr, ["Remark", "Remarks"]),
        orderIds: pick(arr, ["Order Ids", "OrderIds"]),
        remarks3: pick(arr, ["Remarks -3", "Remarks-3", "Remarks3"]),
        rowColor: "",
      });

      const hasAny = Object.values(candidate).some((v) => {
        if (v === null || v === undefined) return false;
        if (v instanceof Date) return !Number.isNaN(v.getTime());
        return String(v).trim() !== "";
      });
      if (hasAny) docs.push(candidate);
    }

    if (!docs.length) {
      return res.json({ ok: true, inserted: 0, skipped: rows.length - 1 });
    }

    const inserted = await insertInChunks(docs, 1000);
    return res.json({ ok: true, inserted, skipped: (rows.length - 1) - inserted });
  } catch (err) {
    console.error("UPLOAD /api/bank-entries/upload error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

/**
 * POST /api/bank-entries/bulk (compat)
 */
router.post("/api/bank-entries/bulk", async (req, res) => {
  try {
    if (!Array.isArray(req.body?.rows) || req.body.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "rows[] required" });
    }

    const mapped = req.body.rows.map((r) =>
      sanitizePayload({
        valueDate: r.valueDate1 ?? null,
        txnDate: r.valueDate2 ?? null,
        description: r.description ?? "",
        refNoChequeNo: r.refNo ?? "",
        branchCode: r.branchCode ?? "",
        debit: r.debit ?? null,
        credit: r.credit ?? null,
        balance: r.balance ?? null,
        remark: r.remark ?? "",
        orderIds: r.orderIds ?? "",
        remarks3: r.remarks3 ?? "",
        rowColor: r.__bg ?? r.rowColor ?? "",
      })
    );

    const inserted = await insertInChunks(mapped, 1000);
    return res.json({ ok: true, inserted });
  } catch (err) {
    console.error("POST /api/bank-entries/bulk error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  }
});

module.exports = router;
