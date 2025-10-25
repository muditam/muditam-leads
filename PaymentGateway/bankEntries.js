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

// dd/mm/yyyy or dd-mm-yyyy -> Date; ISO/other -> Date; Excel serial -> Date
function parseDate(v) {
  if (!v && v !== 0) return null;
  if (typeof v === "number") return excelSerialToDate(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    dd = Number(dd);
    mm = Number(mm);
    yyyy = Number(yyyy.length === 2 ? (yyyy >= 70 ? "19" + yyyy : "20" + yyyy) : yyyy);
    const d = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d2 = new Date(s);
  return Number.isNaN(d2.getTime()) ? null : d2;
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

// Keep empty strings for strings; null for numeric empties; preserve rowColor
function sanitizePayload(b) {
  const trim = (x) => (x == null ? "" : String(x).trim());
  // If client sends "" for numbers, convert to null so clearing a cell persists
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

    // Basic search over description, refNoChequeNo, orderIds, remarks
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

    // NEW: Amount range filter applies to either debit or credit
    if (amountMin != null || amountMax != null) {
      const range = {};
      if (amountMin != null) range.$gte = amountMin;
      if (amountMax != null) range.$lte = amountMax;

      // At least one of debit or credit matches range
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

    // Get header row as first row; normalize headers
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!rows.length) return res.json({ ok: true, inserted: 0, skipped: 0 });

    const rawHeaders = rows[0].map((h) => String(h || "").trim());
    const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/\s/g, "");
    const H = rawHeaders.map(norm);

    // Build header->index map (case/space-insensitive)
    const headerIdx = {};
    H.forEach((h, i) => (headerIdx[h] = i));

    // Accepted aliases -> normalized key we want to read
    const pick = (rowArr, alts) => {
      for (const a of alts) {
        const i = headerIdx[norm(a)];
        if (i != null && rowArr[i] !== undefined) return rowArr[i];
      }
      return "";
    };

    const docs = [];
    for (let r = 1; r < rows.length; r++) {
      const arr = rows[r];
      if (!arr || arr.length === 0) continue;

      const candidate = sanitizePayload({
        valueDate: pick(arr, ["Value Date", "ValueDate", "Posting Date", "PostingDate"]),
        txnDate: pick(arr, ["Value Date 2", "Txn Date", "Transaction Date", "TransactionDate", "Second Value Date"]),
        description: pick(arr, ["Description", "Narration"]),
        refNoChequeNo: pick(arr, ["Ref No./Cheque No.", "Ref No", "Cheque No.", "Ref", "Reference"]),
        branchCode: pick(arr, ["Branch Code", "BranchCode"]),
        debit: pick(arr, ["Debit (Exp)", "Debit", "Dr"]),
        credit: pick(arr, ["Credit (income)", "Credit", "Cr"]),
        balance: pick(arr, ["Balance", "Closing Balance"]),
        remark: pick(arr, ["Remark", "Remarks"]),
        orderIds: pick(arr, ["Order Ids", "OrderIds"]),
        remarks3: pick(arr, ["Remarks -3", "Remarks-3", "Remarks3"]),
        rowColor: "", // uploads default to no color
      });

      // Skip completely empty lines
      const hasAny =
        Object.values(candidate).some(
          (v) => v !== null && v !== undefined && String(v).trim() !== ""
        );
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
 * POST /api/bank-entries/bulk
 * Accepts frontend row-shape and persists in bulk.
 * Body: { rows: [{ valueDate1, valueDate2, description, refNo, ... }] }
 * (Kept for compatibility; front-end now saves row-by-row.)
 */
router.post("/api/bank-entries/bulk", async (req, res) => {
  try {
    if (!Array.isArray(req.body?.rows) || req.body.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "rows[] required" });
    }

    // Map FE keys -> BE expected keys then sanitize
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

