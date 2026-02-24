const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DtdcSettlement = require("../models/DtdcSettlement");

// ✅ ensure upload dir exists
const uploadDir = path.join(__dirname, "..", "uploads", "dtdc");
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

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  // native first
  const d1 = new Date(s);
  if (!Number.isNaN(d1.getTime())) return d1;

  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const yyyy = parseInt(m[3], 10);
    if (dd && mm && yyyy) return new Date(yyyy, mm - 1, dd);
  }
  return null;
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

function parseDateOnlyToYMD(input) {
  if (!input) return null;
  const s = String(input).trim();

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const yyyy = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

// IST day range => converts to correct UTC Date objects
function istDayRange(ymd) {
  const start = new Date(`${ymd}T00:00:00.000+05:30`);
  const end = new Date(`${ymd}T23:59:59.999+05:30`);
  return { start, end };
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

function makeBatchId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

// ✅ shared query builder (used in /data and /export)
function buildQueryFromReq(qs = {}) {
  const {
    q,
    status,
    uploadMin,
    uploadMax,
    bookingMin,
    bookingMax,
    deliveryMin,
    deliveryMax,
    remitMin,
    remitMax,
    codMin,
    codMax,
    remittedMin,
    remittedMax,
  } = qs;

  const query = {};

  // search (CN / CustomerRef / UTR / Status)
  if (q && String(q).trim()) {
    const rx = new RegExp(escapeRegex(String(q).trim()), "i");
    query.$or = [
      { cnNumber: rx },
      { customerReferenceNumber: rx },
      { utrNumber: rx },
      { remittanceStatus: rx },
    ];
  }

  // status contains
  if (status && String(status).trim()) {
    query.remittanceStatus = new RegExp(escapeRegex(String(status).trim()), "i");
  }

  // helper to apply IST day range if input is date-only (YYYY-MM-DD or DD/MM/YYYY)
  const applyDateRange = (field, minV, maxV) => {
    if (!minV && !maxV) return;

    query[field] = {};

    const minYmd = parseDateOnlyToYMD(minV);
    const maxYmd = parseDateOnlyToYMD(maxV);

    if (minYmd) query[field].$gte = istDayRange(minYmd).start;
    else if (minV) {
      const d = parseDate(minV);
      if (d) query[field].$gte = d;
    }

    if (maxYmd) query[field].$lte = istDayRange(maxYmd).end;
    else if (maxV) {
      const d = parseDate(maxV);
      if (d) query[field].$lte = d;
    }

    if (!Object.keys(query[field]).length) delete query[field];
  };

  applyDateRange("uploadDate", uploadMin, uploadMax);
  applyDateRange("bookingDate", bookingMin, bookingMax);
  applyDateRange("deliveryDate", deliveryMin, deliveryMax);
  applyDateRange("remittanceDate", remitMin, remitMax);

  // COD range
  const cMin = codMin !== undefined && codMin !== "" ? Number(codMin) : null;
  const cMax = codMax !== undefined && codMax !== "" ? Number(codMax) : null;
  if (cMin !== null || cMax !== null) {
    query.codAmount = {};
    if (cMin !== null && !Number.isNaN(cMin)) query.codAmount.$gte = cMin;
    if (cMax !== null && !Number.isNaN(cMax)) query.codAmount.$lte = cMax;
    if (!Object.keys(query.codAmount).length) delete query.codAmount;
  }

  // Remitted range
  const rmMin = remittedMin !== undefined && remittedMin !== "" ? Number(remittedMin) : null;
  const rmMax = remittedMax !== undefined && remittedMax !== "" ? Number(remittedMax) : null;
  if (rmMin !== null || rmMax !== null) {
    query.remittedAmount = {};
    if (rmMin !== null && !Number.isNaN(rmMin)) query.remittedAmount.$gte = rmMin;
    if (rmMax !== null && !Number.isNaN(rmMax)) query.remittedAmount.$lte = rmMax;
    if (!Object.keys(query.remittedAmount).length) delete query.remittedAmount;
  }

  return query;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtDateYMD(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ✅ GET /sample (download sample CSV)
router.get("/sample", (req, res) => {
  const header = [
    "CN Number",
    "Customer Reference Number",
    "Booking Date",
    "Delivery Date",
    "COD Amount",
    "Remitted Amount",
    "Remittance Status",
    "UTR Number",
    "Remittance Date",
  ].join(",");

  const sampleRow = [
    "Z1234567890",
    "MA123456",
    "16/02/2026",
    "18/02/2026",
    "999",
    "999",
    "Remitted",
    "UTR12345",
    "19/02/2026",
  ].join(",");

  const csvContent = `${header}\n${sampleRow}\n`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="dtdc_upload_sample.csv"');
  return res.send(csvContent);
});

// ------------------- POST /upload -------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });

  const filePath = req.file.path;

  try {
    const rows = await readCsvFile(filePath);
    if (!rows.length) {
      safeUnlink(filePath);
      return res.status(400).json({ error: "No rows parsed from CSV." });
    }

    const batchId = makeBatchId(); // ✅ one batch id per upload

    const records = rows.map((row) => {
      const cnNumber = pick(row, ["CN Number", "CN No", "CNNumber", "CN"]);
      const customerReferenceNumber = pick(row, [
        "Customer Reference Number",
        "Customer Ref No",
        "Customer Reference",
        "CRN",
      ]);

      const bookingRaw = pick(row, ["Booking Date", "Booking"]);
      const deliveryRaw = pick(row, ["Delivery Date", "Delivery"]);
      const remittanceRaw = pick(row, ["Remittance Date", "Remit Date", "Remittance"]);

      const codRaw = pick(row, ["COD Amount", "COD"]);
      const remittedRaw = pick(row, ["Remitted Amount", "Remitted", "Remittance Amount"]);

      const remittanceStatus = pick(row, ["Remittance Status", "Status"]);
      const utrNumber = pick(row, ["UTR Number", "UTR No", "UTR"]);

      return {
        uploadDate: new Date(),
        uploadBatchId: batchId,

        cnNumber: cnNumber || "",
        customerReferenceNumber: customerReferenceNumber || "",

        bookingDate: parseDate(bookingRaw),
        deliveryDate: parseDate(deliveryRaw),

        codAmount: parseNum(codRaw),
        remittedAmount: parseNum(remittedRaw),

        remittanceStatus: remittanceStatus || "",
        utrNumber: utrNumber || "",

        remittanceDate: parseDate(remittanceRaw),
      };
    });

    await DtdcSettlement.insertMany(records, { ordered: false });

    safeUnlink(filePath);
    return res.json({ message: "Upload successful", inserted: records.length, batchId });
  } catch (err) {
    console.error("DTDC upload error:", err);
    safeUnlink(filePath);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ✅ DELETE /delete-last-upload (delete latest uploaded batch)
router.delete("/delete-last-upload", async (req, res) => {
  try {
    const latest = await DtdcSettlement.findOne({})
      .sort({ uploadDate: -1, createdAt: -1 })
      .select({ _id: 1, uploadBatchId: 1 })
      .lean();

    if (!latest) return res.json({ ok: true, deleted: 0, message: "No data to delete" });

    if (latest.uploadBatchId) {
      const r = await DtdcSettlement.deleteMany({ uploadBatchId: latest.uploadBatchId });
      return res.json({ ok: true, deleted: r.deletedCount || 0, batchId: latest.uploadBatchId });
    }

    const r = await DtdcSettlement.deleteOne({ _id: latest._id });
    return res.json({
      ok: true,
      deleted: r.deletedCount || 0,
      message: "Deleted latest row (no batchId found)",
    });
  } catch (err) {
    console.error("DTDC delete-last-upload error:", err);
    return res.status(500).json({ error: "Failed to delete last upload" });
  }
});

// ------------------- GET /data (with filters + total sum of remitted) -------------------
router.get("/data", async (req, res) => {
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || 50;
  if (page < 1) page = 1;
  if (limit < 1) limit = 50;
  limit = Math.min(limit, 500);

  const skip = (page - 1) * limit;

  try {
    const query = buildQueryFromReq(req.query);

    const [totalCount, data, sumAgg] = await Promise.all([
      DtdcSettlement.countDocuments(query),
      DtdcSettlement.find(query)
        .sort({ uploadDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DtdcSettlement.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: "$remittedAmount" } } },
      ]),
    ]);

    const totalRemittedAmount = sumAgg?.[0]?.total || 0;

    return res.json({
      data,
      page,
      limit,
      totalCount,
      pages: Math.ceil(totalCount / limit),
      totalRemittedAmount, // ✅ NEW
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch DTDC data" });
  }
});

// ------------------- GET /export (all / filtered) -------------------
router.get("/export", async (req, res) => {
  try {
    const query = buildQueryFromReq(req.query);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="dtdc_export.csv"');

    // header
    res.write(
      [
        "Upload Date",
        "CN Number",
        "Customer Reference Number",
        "Booking Date",
        "Delivery Date",
        "COD Amount",
        "Remitted Amount",
        "Remittance Status",
        "UTR Number",
        "Remittance Date",
      ].join(",") + "\n"
    );

    const cursor = DtdcSettlement.find(query)
      .sort({ uploadDate: -1, createdAt: -1 })
      .lean()
      .cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      const line =
        [
          csvEscape(fmtDateYMD(doc.uploadDate)),
          csvEscape(doc.cnNumber || ""),
          csvEscape(doc.customerReferenceNumber || ""),
          csvEscape(fmtDateYMD(doc.bookingDate)),
          csvEscape(fmtDateYMD(doc.deliveryDate)),
          csvEscape(doc.codAmount ?? 0),
          csvEscape(doc.remittedAmount ?? 0),
          csvEscape(doc.remittanceStatus || ""),
          csvEscape(doc.utrNumber || ""),
          csvEscape(fmtDateYMD(doc.remittanceDate)),
        ].join(",") + "\n";

      if (!res.write(line)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }

    res.end();
  } catch (err) {
    console.error("DTDC export error:", err);
    return res.status(500).json({ error: "Failed to export DTDC data" });
  }
});

router.get("/count-upload-date", async (req, res) => {
  try {
    const ymd = parseDateOnlyToYMD(req.query.date);
    if (!ymd) return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD or DD/MM/YYYY" });

    const { start, end } = istDayRange(ymd);

    const count = await DtdcSettlement.countDocuments({
      uploadDate: { $gte: start, $lte: end },
    });

    return res.json({
      ok: true,
      date: ymd,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      count,
    });
  } catch (err) {
    console.error("DTDC count-upload-date error:", err);
    return res.status(500).json({ error: "Failed to count DTDC records" });
  }
});

// ✅ Delete rows uploaded on that date (IST)
// DELETE /api/dtdc/delete-upload-date?date=16/02/2026  (or 2026-02-16)
router.delete("/delete-upload-date", async (req, res) => {
  try {
    const ymd = parseDateOnlyToYMD(req.query.date);
    if (!ymd) return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD or DD/MM/YYYY" });

    const { start, end } = istDayRange(ymd);

    const result = await DtdcSettlement.deleteMany({
      uploadDate: { $gte: start, $lte: end },
    });

    return res.json({
      ok: true,
      date: ymd,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      deleted: result.deletedCount || 0,
    });
  } catch (err) {
    console.error("DTDC delete-upload-date error:", err);
    return res.status(500).json({ error: "Failed to delete DTDC records" });
  }
});

module.exports = router;
