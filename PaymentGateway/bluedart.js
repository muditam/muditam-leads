// routes/bluedart.routes.js
const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BluedartSettlement = require("../models/BluedartSettlement");

const router = express.Router();

const uploadDir = path.join(__dirname, "..", "uploads", "bluedart");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------- helpers ----------
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

  const d1 = new Date(s);
  if (!Number.isNaN(d1.getTime())) return d1;

  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const yyyy = parseInt(m[3], 10);
    if (dd && mm && yyyy) return new Date(yyyy, mm - 1, dd);
  }
  return null;
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

function istDayRange(dateOnlyStr) {
  const start = new Date(`${dateOnlyStr}T00:00:00.000+05:30`);
  const end = new Date(`${dateOnlyStr}T23:59:59.999+05:30`);
  return { start, end };
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

function makeBatchId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

// ✅ Build Mongo query once (used by /data and /export)
function buildQueryFromReq(reqQuery = {}) {
  const { q, portal, uploadMin, uploadMax, settledMin, settledMax, amountMin, amountMax } = reqQuery;
  const query = {};

  if (q && String(q).trim()) {
    const rx = new RegExp(escapeRegex(String(q).trim()), "i");
    query.$or = [{ awbNo: rx }, { orderId: rx }, { portalName: rx }, { utr: rx }];
  }

  if (portal && String(portal).trim()) {
    query.portalName = new RegExp(escapeRegex(String(portal).trim()), "i");
  }

  // upload date range (IST day if date-only)
  if (uploadMin || uploadMax) {
    query.uploadDate = {};
    const uMinYMD = parseDateOnlyToYMD(uploadMin);
    const uMaxYMD = parseDateOnlyToYMD(uploadMax);

    if (uMinYMD) query.uploadDate.$gte = istDayRange(uMinYMD).start;
    else if (uploadMin) {
      const d = parseDate(uploadMin);
      if (d) query.uploadDate.$gte = d;
    }

    if (uMaxYMD) query.uploadDate.$lte = istDayRange(uMaxYMD).end;
    else if (uploadMax) {
      const d = parseDate(uploadMax);
      if (d) query.uploadDate.$lte = d;
    }

    if (!Object.keys(query.uploadDate).length) delete query.uploadDate;
  }

  // settled date range (IST day if date-only)
  if (settledMin || settledMax) {
    query.settledDate = {};
    const sMinYMD = parseDateOnlyToYMD(settledMin);
    const sMaxYMD = parseDateOnlyToYMD(settledMax);

    if (sMinYMD) query.settledDate.$gte = istDayRange(sMinYMD).start;
    else if (settledMin) {
      const d = parseDate(settledMin);
      if (d) query.settledDate.$gte = d;
    }

    if (sMaxYMD) query.settledDate.$lte = istDayRange(sMaxYMD).end;
    else if (settledMax) {
      const d = parseDate(settledMax);
      if (d) query.settledDate.$lte = d;
    }

    if (!Object.keys(query.settledDate).length) delete query.settledDate;
  }

  // amount range
  const aMin = amountMin !== undefined && amountMin !== "" ? Number(amountMin) : null;
  const aMax = amountMax !== undefined && amountMax !== "" ? Number(amountMax) : null;
  if (aMin !== null || aMax !== null) {
    query.customerPayAmt = {};
    if (aMin !== null && !Number.isNaN(aMin)) query.customerPayAmt.$gte = aMin;
    if (aMax !== null && !Number.isNaN(aMax)) query.customerPayAmt.$lte = aMax;
    if (!Object.keys(query.customerPayAmt).length) delete query.customerPayAmt;
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

// ------------------- GET /sample -------------------
router.get("/sample", (req, res) => {
  const header = [
    "AWB NO",
    "DPUDATE",
    "PROCESS_DT",
    "ORDER ID",
    "PORTAL NAME",
    "NCUSTPAYAMT",
    "UTR",
    "SETTLED DATE",
  ].join(",");

  const sampleRow = [
    "1234567890",
    "15/02/2026",
    "15/02/2026",
    "MA123456",
    "Shopify",
    "999",
    "UTR12345",
    "16/02/2026",
  ].join(",");

  const csvContent = `${header}\n${sampleRow}\n`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="bluedart_upload_sample.csv"');
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

    const batchId = makeBatchId();

    const records = rows.map((row) => {
      const awbNo = pick(row, ["AWB NO", "CRTOAWBNO", "AWB"]);
      const dpuDateRaw = pick(row, ["DPUDATE", "DPU DATE"]);
      const processDateRaw = pick(row, ["PROCESS_DT", "PROCESS DT"]);
      const orderId = pick(row, ["ORDER ID", "Order ID"]);
      const portalName = pick(row, ["PORTAL NAME", "PortalName", "PORTAL"]);
      const amountRaw = pick(row, ["NCUSTPAYAMT", "Customer Pay Amount"]);
      const utr = pick(row, ["UTR", "UTR NO"]);
      const settledDateRaw = pick(row, ["SETTLED DATE", "Settled Date"]);

      return {
        uploadDate: new Date(),
        uploadBatchId: batchId,

        awbNo: awbNo || "",
        dpuDate: parseDate(dpuDateRaw),
        processDate: parseDate(processDateRaw),
        orderId: orderId || "",
        portalName: portalName || "",
        customerPayAmt: parseNum(amountRaw),
        utr: utr || "",
        settledDate: parseDate(settledDateRaw),
      };
    });

    await BluedartSettlement.insertMany(records, { ordered: false });

    safeUnlink(filePath);
    return res.json({ message: "Upload successful", inserted: records.length, batchId });
  } catch (err) {
    console.error("Bluedart upload error:", err);
    safeUnlink(filePath);
    return res.status(500).json({ error: "Failed to upload data" });
  }
});

// ------------------- DELETE /delete-last-upload -------------------
router.delete("/delete-last-upload", async (req, res) => {
  try {
    const latest = await BluedartSettlement.findOne({})
      .sort({ uploadDate: -1, createdAt: -1 })
      .select({ _id: 1, uploadBatchId: 1 })
      .lean();

    if (!latest) return res.json({ ok: true, deleted: 0, message: "No data to delete" });

    if (latest.uploadBatchId) {
      const r = await BluedartSettlement.deleteMany({ uploadBatchId: latest.uploadBatchId });
      return res.json({ ok: true, deleted: r.deletedCount || 0, batchId: latest.uploadBatchId });
    }

    const r = await BluedartSettlement.deleteOne({ _id: latest._id });
    return res.json({
      ok: true,
      deleted: r.deletedCount || 0,
      message: "Deleted latest row (no batchId found)",
    });
  } catch (err) {
    console.error("delete-last-upload error:", err);
    return res.status(500).json({ error: "Failed to delete last upload" });
  }
});

// ------------------- GET /data (with filters + total sum) -------------------
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
      BluedartSettlement.countDocuments(query),
      BluedartSettlement.find(query)
        .sort({ uploadDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BluedartSettlement.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: "$customerPayAmt" } } },
      ]),
    ]);

    const totalCustomerPayAmt = sumAgg?.[0]?.total || 0;

    return res.json({
      data,
      page,
      limit,
      totalCount,
      pages: Math.ceil(totalCount / limit),
      totalCustomerPayAmt, // ✅ NEW
    });
  } catch (err) {
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

// ------------------- GET /export (all / filtered) -------------------
router.get("/export", async (req, res) => {
  try {
    const query = buildQueryFromReq(req.query);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="bluedart_export.csv"'
    );

    // header
    res.write(
      [
        "Upload Date",
        "AWB No",
        "DPU Date",
        "Process Date",
        "Order ID",
        "Portal Name",
        "Customer Pay Amount",
        "UTR",
        "Settled Date",
      ].join(",") + "\n"
    );

    const cursor = BluedartSettlement.find(query)
      .sort({ uploadDate: -1, createdAt: -1 })
      .lean()
      .cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      const line = [
        csvEscape(fmtDateYMD(doc.uploadDate)),
        csvEscape(doc.awbNo || ""),
        csvEscape(fmtDateYMD(doc.dpuDate)),
        csvEscape(fmtDateYMD(doc.processDate)),
        csvEscape(doc.orderId || ""),
        csvEscape(doc.portalName || ""),
        csvEscape(doc.customerPayAmt ?? 0),
        csvEscape(doc.utr || ""),
        csvEscape(fmtDateYMD(doc.settledDate)),
      ].join(",") + "\n";

      if (!res.write(line)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }

    res.end();
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: "Failed to export data" });
  }
});

module.exports = router;
