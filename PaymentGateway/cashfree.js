// routes/cashfree.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CashfreeSettlement = require("../models/CashfreeSettlement");

// ✅ ensure upload dir exists
const uploadDir = path.join(__dirname, "..", "uploads", "cashfree");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------- helper: safely read possible header variants ----------
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNum(value) {
  if (value === undefined || value === null) return 0;
  let s = String(value).trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return 0;
  s = s.replace(/[,₹\s]/g, "");
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

// Supports ISO, dd/mm/yyyy, dd-mm-yyyy, and dd-MMM-yy / dd-MMM-yyyy (e.g. 21-Jan-26)
function parseDate(value) {
  if (!value) return null;
  const s0 = String(value).trim();
  if (!s0) return null;

  // native parse first
  const d1 = new Date(s0);
  if (!Number.isNaN(d1.getTime())) return d1;

  // dd/mm/yyyy or dd-mm-yyyy
  const m = s0.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const yyyy = parseInt(m[3], 10);
    if (dd && mm && yyyy) return new Date(yyyy, mm - 1, dd);
  }

  // dd-MMM-yy or dd-MMM-yyyy
  const m2 = s0.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m2) {
    const dd = parseInt(m2[1], 10);
    const mon = m2[2].toLowerCase();
    const yy = m2[3];
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const mm = months[mon];
    if (mm !== undefined) {
      const yyyy = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
      return new Date(yyyy, mm, dd);
    }
  }

  return null;
}

function parseDateParam(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // YYYY-MM-DD from <input type="date" />
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let d = null;

  if (m) {
    const yyyy = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const dd = parseInt(m[3], 10);
    d = new Date(yyyy, mm - 1, dd);
  } else {
    d = parseDate(s);
  }

  if (!d || Number.isNaN(d.getTime())) return null;

  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);

  return d;
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

async function readCsvFile(filePath) {
  const separator = await detectSeparator(filePath);
  const rows = [];

  const mapHeaders = ({ header }) =>
    String(header || "")
      .replace(/\uFEFF/g, "")
      .replace(/\s+/g, " ")
      .trim();

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv({ separator, mapHeaders }))
      .on("data", (row) => rows.push(row))
      .on("end", resolve)
      .on("error", reject);
  });

  return rows;
}

function safeUnlink(p) {
  fs.unlink(p, () => {});
}

// ------------------- GET /sample -------------------
router.get("/sample", (req, res) => {
  const sample =
    "Order ID,Amount Received,Date of Payment,Transaction ID,Utr No,Date of Settlement\n" +
    "MA12345,1520,2026-02-16,tx_123ABC,UTR123456,2026-02-18\n";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="cashfree_sample.csv"');
  return res.status(200).send(sample);
});

// ------------------- POST /upload -------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });

  const filePath = req.file.path;

  // ✅ one batch id + one uploadDate for all rows
  const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const batchAt = new Date();

  try {
    const rows = await readCsvFile(filePath);
    if (!rows.length) {
      safeUnlink(filePath);
      return res.status(400).json({ error: "No rows parsed from CSV." });
    }

    const records = rows.map((row) => {
      const orderId = pick(row, ["Order ID", "Order Id", "order_id", "Order"]);
      const amountReceivedRaw = pick(row, ["Amount Received", "Amount", "amount_received"]);
      const dopRaw = pick(row, ["Date of Payment", "Payment Date", "date_of_payment"]);
      const transactionId = pick(row, ["Transaction ID", "Transaction Id", "transaction_id", "Payment Id"]);
      const utrNo = pick(row, ["Utr No", "UTR No", "Utr", "UTR", "utr_no"]);
      const dosRaw = pick(row, ["Date of Settlement", "Settlement Date", "date_of_settlement"]);

      return {
        uploadDate: batchAt,
        uploadBatchId: batchId,

        orderId: orderId || "",
        amountReceived: parseNum(amountReceivedRaw),
        dateOfPayment: parseDate(dopRaw),
        transactionId: transactionId || "",
        utrNo: utrNo || "",
        dateOfSettlement: parseDate(dosRaw),
      };
    });

    await CashfreeSettlement.insertMany(records, { ordered: false });

    safeUnlink(filePath);
    return res.json({ message: "Upload successful", inserted: records.length });
  } catch (err) {
    console.error("Cashfree upload error:", err);
    safeUnlink(filePath);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ------------------- DELETE /delete-last-upload -------------------
router.delete("/delete-last-upload", async (req, res) => {
  try {
    const last = await CashfreeSettlement.findOne().sort({ uploadDate: -1, createdAt: -1 }).lean();
    if (!last) return res.json({ deleted: 0 });

    let deleted = 0;

    if (last.uploadBatchId) {
      const r = await CashfreeSettlement.deleteMany({ uploadBatchId: last.uploadBatchId });
      deleted = r.deletedCount || 0;
    } else if (last.uploadDate) {
      const t = new Date(last.uploadDate).getTime();
      const start = new Date(t - 2 * 60 * 1000);
      const end = new Date(t + 2 * 60 * 1000);
      const r = await CashfreeSettlement.deleteMany({ uploadDate: { $gte: start, $lte: end } });
      deleted = r.deletedCount || 0;
    }

    return res.json({ deleted });
  } catch (err) {
    console.error("Cashfree delete-last-upload error:", err);
    return res.status(500).json({ error: "Failed to delete last upload" });
  }
});

// ------------------- GET /data (filters + pagination) -------------------
router.get("/data", async (req, res) => {
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || 50;
  if (page < 1) page = 1;
  if (limit < 1) limit = 50;
  limit = Math.min(limit, 500);
  const skip = (page - 1) * limit;

  try {
    const {
      q,
      uploadMin,
      uploadMax,
      paymentMin,
      paymentMax,
      settlementMin,
      settlementMax,
      amountMin,
      amountMax,
    } = req.query;

    const query = {};

    // search
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [{ orderId: rx }, { transactionId: rx }, { utrNo: rx }];
    }

    // upload date range
    if (uploadMin || uploadMax) {
      query.uploadDate = {};
      const dMin = parseDateParam(uploadMin, false);
      const dMax = parseDateParam(uploadMax, true);
      if (dMin) query.uploadDate.$gte = dMin;
      if (dMax) query.uploadDate.$lte = dMax;
      if (!Object.keys(query.uploadDate).length) delete query.uploadDate;
    }

    // payment date range
    if (paymentMin || paymentMax) {
      query.dateOfPayment = {};
      const pMin = parseDateParam(paymentMin, false);
      const pMax = parseDateParam(paymentMax, true);
      if (pMin) query.dateOfPayment.$gte = pMin;
      if (pMax) query.dateOfPayment.$lte = pMax;
      if (!Object.keys(query.dateOfPayment).length) delete query.dateOfPayment;
    }

    // settlement date range
    if (settlementMin || settlementMax) {
      query.dateOfSettlement = {};
      const sMin = parseDateParam(settlementMin, false);
      const sMax = parseDateParam(settlementMax, true);
      if (sMin) query.dateOfSettlement.$gte = sMin;
      if (sMax) query.dateOfSettlement.$lte = sMax;
      if (!Object.keys(query.dateOfSettlement).length) delete query.dateOfSettlement;
    }

    // amount range
    const aMin = amountMin !== undefined && amountMin !== "" ? Number(amountMin) : null;
    const aMax = amountMax !== undefined && amountMax !== "" ? Number(amountMax) : null;
    if (aMin !== null || aMax !== null) {
      query.amountReceived = {};
      if (aMin !== null && !Number.isNaN(aMin)) query.amountReceived.$gte = aMin;
      if (aMax !== null && !Number.isNaN(aMax)) query.amountReceived.$lte = aMax;
      if (!Object.keys(query.amountReceived).length) delete query.amountReceived;
    }

    const [totalCount, data] = await Promise.all([
      CashfreeSettlement.countDocuments(query),
      CashfreeSettlement.find(query)
        .sort({ uploadDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      data,
      page,
      limit,
      totalCount,
      pages: Math.ceil(totalCount / limit),
    });
  } catch (err) {
    console.error("Cashfree fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch Cashfree data" });
  }
});

module.exports = router;
