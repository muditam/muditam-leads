const express = require("express");
const router = express.Router();
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const DelhiverySettlement = require("../models/DelhiverySettlement");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "delhivery"),
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
      // common headers
      const awbNo = pick(row, ["AWB NO", "AWB No", "AWB", "Waybill", "Waybill No"]);
      const utrNo = pick(row, ["UTR NO", "UTR No", "UTR"]);
      const orderId = pick(row, ["ORDER ID", "Order ID", "Order"]);
      const amountRaw = pick(row, ["AMOUNT", "Amount"]);
      const settledRaw = pick(row, ["SETTLED DATE", "Settled Date", "SETTLED"]);

      return {
        uploadDate: new Date(),
        awbNo: awbNo || "",
        utrNo: utrNo || "",
        orderId: orderId || "",
        amount: parseNum(amountRaw),
        settledDate: parseDate(settledRaw), // store as Date for filtering
      };
    });

    await DelhiverySettlement.insertMany(records, { ordered: false });

    fs.unlink(filePath, () => {});
    return res.json({ message: "Upload successful", inserted: records.length });
  } catch (err) {
    console.error("Delhivery upload error:", err);
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
      settledMin,
      settledMax,
      amountMin,
      amountMax,
    } = req.query;

    const query = {};

    // search
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [{ awbNo: rx }, { orderId: rx }, { utrNo: rx }];
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
      query.amount = {};
      if (aMin !== null && !Number.isNaN(aMin)) query.amount.$gte = aMin;
      if (aMax !== null && !Number.isNaN(aMax)) query.amount.$lte = aMax;
      if (!Object.keys(query.amount).length) delete query.amount;
    }

    const [totalCount, data] = await Promise.all([
      DelhiverySettlement.countDocuments(query),
      DelhiverySettlement.find(query)
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
    return res.status(500).json({ error: "Failed to fetch Delhivery data" });
  }
});

module.exports = router;
