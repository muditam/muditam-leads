// routes/bluedart.routes.js
const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BluedartSettlement = require("../models/BluedartSettlement");

const router = express.Router();

// ✅ ensure upload dir exists
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

function parseDateParam(v) {
  const d = parseDate(v);
  return d && !Number.isNaN(d.getTime()) ? d : null;
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

  // Accept: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const yyyy = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // Accept: DD/MM/YYYY or DD-MM-YYYY
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
  // dateOnlyStr must be YYYY-MM-DD
  const start = new Date(`${dateOnlyStr}T00:00:00.000+05:30`);
  const end = new Date(`${dateOnlyStr}T23:59:59.999+05:30`);
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

    const batchId = makeBatchId(); // ✅ one batch id per upload/file

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
        uploadBatchId: batchId, // ✅

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

    // fallback (shouldn’t be needed after batchId rollout)
    const r = await BluedartSettlement.deleteOne({ _id: latest._id });
    return res.json({ ok: true, deleted: r.deletedCount || 0, message: "Deleted latest row (no batchId found)" });
  } catch (err) {
    console.error("delete-last-upload error:", err);
    return res.status(500).json({ error: "Failed to delete last upload" });
  }
});

// ------------------- GET /data (with filters) -------------------
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
      portal,
      uploadMin,
      uploadMax,
      settledMin,
      settledMax,
      amountMin,
      amountMax,
    } = req.query;

    const query = {};

    // q search
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [{ awbNo: rx }, { orderId: rx }, { portalName: rx }, { utr: rx }];
    }

    // portal filter
    if (portal && String(portal).trim()) {
      query.portalName = new RegExp(escapeRegex(String(portal).trim()), "i");
    }

    // upload date range
    if (uploadMin || uploadMax) {
      query.uploadDate = {};
      const dMin = parseDateParam(uploadMin);
      const dMax = parseDateParam(uploadMax);
      if (dMin) query.uploadDate.$gte = dMin;
      if (dMax) query.uploadDate.$lte = dMax;
      if (!Object.keys(query.uploadDate).length) delete query.uploadDate;
    }

    // settled date range
    if (settledMin || settledMax) {
      query.settledDate = {};
      const sMin = parseDateParam(settledMin);
      const sMax = parseDateParam(settledMax);
      if (sMin) query.settledDate.$gte = sMin;
      if (sMax) query.settledDate.$lte = sMax;
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

    const [totalCount, data] = await Promise.all([
      BluedartSettlement.countDocuments(query),
      BluedartSettlement.find(query)
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
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

module.exports = router;

 