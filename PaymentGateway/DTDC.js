const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const DtdcSettlement = require("../models/DtdcSettlement");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "dtdc"),
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

// ------------------- POST /upload -------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });

  const filePath = req.file.path;

  try {
    const rows = await readCsvFile(filePath);
    if (!rows.length) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: "No rows parsed from CSV." });
    }

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

    fs.unlink(filePath, () => {});
    return res.json({ message: "Upload successful", inserted: records.length });
  } catch (err) {
    console.error("DTDC upload error:", err);
    fs.unlink(filePath, () => {});
    return res.status(500).json({ error: "Upload failed" });
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

      status,
    } = req.query;

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

    // status exact-ish filter (contains)
    if (status && String(status).trim()) {
      query.remittanceStatus = new RegExp(escapeRegex(String(status).trim()), "i");
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

    // booking date range
    if (bookingMin || bookingMax) {
      query.bookingDate = {};
      const bMin = parseDateParam(bookingMin);
      const bMax = parseDateParam(bookingMax);
      if (bMin) query.bookingDate.$gte = bMin;
      if (bMax) query.bookingDate.$lte = bMax;
      if (!Object.keys(query.bookingDate).length) delete query.bookingDate;
    }

    // delivery date range
    if (deliveryMin || deliveryMax) {
      query.deliveryDate = {};
      const dMin = parseDateParam(deliveryMin);
      const dMax = parseDateParam(deliveryMax);
      if (dMin) query.deliveryDate.$gte = dMin;
      if (dMax) query.deliveryDate.$lte = dMax;
      if (!Object.keys(query.deliveryDate).length) delete query.deliveryDate;
    }

    // remittance date range
    if (remitMin || remitMax) {
      query.remittanceDate = {};
      const rMin = parseDateParam(remitMin);
      const rMax = parseDateParam(remitMax);
      if (rMin) query.remittanceDate.$gte = rMin;
      if (rMax) query.remittanceDate.$lte = rMax;
      if (!Object.keys(query.remittanceDate).length) delete query.remittanceDate;
    }

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

    const [totalCount, data] = await Promise.all([
      DtdcSettlement.countDocuments(query),
      DtdcSettlement.find(query)
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
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch DTDC data" });
  }
});

module.exports = router;
