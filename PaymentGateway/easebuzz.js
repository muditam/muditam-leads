const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EasebuzzTransaction = require("../models/EasebuzzTransaction");

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "easebuzz"),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------- helper: resilient field getter (handles header variants) ----------
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// parse numbers like "₹1,234.56", " 1,234 "
const num = (v) => {
  if (v == null) return 0;
  const clean = String(v).replace(/[,₹\s]/g, "");
  const n = parseFloat(clean);
  return Number.isNaN(n) ? 0 : n;
};

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

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

// ------------------- POST /upload -------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });

  const filePath = req.file.path;
  const rows = [];

  // ✅ one batch id + one uploadDate for all rows (delete-last works perfectly)
  const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const batchAt = new Date();

  try {
    fs.createReadStream(filePath)
      .pipe(
        csv({
          mapHeaders: ({ header }) =>
            String(header || "")
              .replace(/\uFEFF/g, "")
              .replace(/\s+/g, " ")
              .trim(),
          separator: ",",
        })
      )
      .on("data", (data) => {
        const serialNo = pick(data, ["S. No.", "S.No.", "S No", "S No."]);
        const transactionType = pick(data, ["Transaction Type"]);
        const paymentId = pick(data, ["Payment Id", "Payment ID"]);
        const orderId = pick(data, ["Order Id", "Order ID"]);
        const amount = num(pick(data, ["Amount"]));
        const currency = pick(data, ["Currency"]);
        const tax = num(pick(data, ["Tax"]));
        const fee = num(pick(data, ["Fee"]));
        const additionalFees = num(pick(data, ["Additional Fees"]));
        const additionalTax = num(pick(data, ["Additional Tax"]));
        const debit = num(pick(data, ["Debit"]));
        const gokwikDeduction = num(
          pick(data, ["gokwik Deduction", "GoKwik Deduction", "Gokwik Deduction"])
        );
        const credit = num(pick(data, ["Credit"]));
        const paymentMethod = pick(data, ["Payment Method"]);
        const transactionDate = pick(data, ["Transaction Date"]);
        const transactionRRN = pick(data, ["Transaction RRN"]);
        const merchantOrderId = pick(data, ["Merchant Order Id", "Merchant Order ID"]);
        const shopifyOrderId = pick(data, ["Shopify Order Id", "Shopify Order ID"]);
        const shopifyTransactionId = pick(data, ["Shopify Transaction Id", "Shopify Transaction ID"]);
        const settlementUTR = pick(data, ["Settlement UTR", "UTR Number", "UTR"]);
        const settlementDateRaw = pick(data, ["Settlement Date"]);
        const settledBy = pick(data, ["Settled By"]);
        const paymentMode = pick(data, ["Payment Mode"]);
        const bankCode = pick(data, ["Bank Code"]);
        const cardNetwork = pick(data, ["Card Network"]);

        rows.push({
          uploadDate: batchAt,
          uploadBatchId: batchId,

          serialNo: serialNo || "",
          transactionType: transactionType || "",
          paymentId: paymentId || "",
          orderId: orderId || "",

          amount,
          currency: currency || "",
          tax,
          fee,
          additionalFees,
          additionalTax,
          debit,
          gokwikDeduction,
          credit,

          paymentMethod: paymentMethod || "",
          transactionDate: transactionDate || "",
          transactionRRN: transactionRRN || "",

          merchantOrderId: merchantOrderId || "",
          shopifyOrderId: shopifyOrderId || "",
          shopifyTransactionId: shopifyTransactionId || "",

          settlementUTR: settlementUTR || "",
          settlementDate: parseDate(settlementDateRaw),

          settledBy: settledBy || "",
          paymentMode: paymentMode || "",
          bankCode: bankCode || "",
          cardNetwork: cardNetwork || "",
        });
      })
      .on("end", async () => {
        try {
          if (!rows.length) {
            fs.unlink(filePath, () => {});
            return res.status(400).json({ error: "No rows parsed from CSV." });
          }

          await EasebuzzTransaction.insertMany(rows, { ordered: false });
          fs.unlink(filePath, () => {});
          return res.json({ message: "Upload successful", inserted: rows.length });
        } catch (e) {
          console.error("DB insert error:", e);
          fs.unlink(filePath, () => {});
          return res.status(500).json({ error: "Failed to insert rows" });
        }
      })
      .on("error", (e) => {
        console.error("CSV parse error:", e);
        fs.unlink(filePath, () => {});
        return res.status(400).json({ error: "Invalid CSV" });
      });
  } catch (err) {
    console.error("Easebuzz upload error:", err);
    fs.unlink(filePath, () => {});
    return res.status(500).json({ error: "Upload failed" });
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
    const { q, uploadMin, uploadMax, settleMin, settleMax, amountMin, amountMax } = req.query;

    const query = {};

    // search across common identifiers
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [
        { orderId: rx },
        { paymentId: rx },
        { settlementUTR: rx },
        { transactionRRN: rx },
        { merchantOrderId: rx },
        { shopifyOrderId: rx },
        { shopifyTransactionId: rx },
        { paymentMethod: rx },
        { transactionType: rx },
      ];
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

    // settlement date range
    if (settleMin || settleMax) {
      query.settlementDate = {};
      const sMin = parseDateParam(settleMin);
      const sMax = parseDateParam(settleMax);
      if (sMin) query.settlementDate.$gte = sMin;
      if (sMax) query.settlementDate.$lte = sMax;
      if (!Object.keys(query.settlementDate).length) delete query.settlementDate;
    }

    // amount range (on Amount column)
    const aMin = amountMin !== undefined && amountMin !== "" ? Number(amountMin) : null;
    const aMax = amountMax !== undefined && amountMax !== "" ? Number(amountMax) : null;
    if (aMin !== null || aMax !== null) {
      query.amount = {};
      if (aMin !== null && !Number.isNaN(aMin)) query.amount.$gte = aMin;
      if (aMax !== null && !Number.isNaN(aMax)) query.amount.$lte = aMax;
      if (!Object.keys(query.amount).length) delete query.amount;
    }

    const [totalCount, data] = await Promise.all([
      EasebuzzTransaction.countDocuments(query),
      EasebuzzTransaction.find(query)
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
    console.error("Fetch Easebuzz error:", err);
    return res.status(500).json({ error: "Failed to fetch Easebuzz data" });
  }
});

// ------------------- DELETE /delete-last-upload -------------------
router.delete("/delete-last-upload", async (req, res) => {
  try {
    const last = await EasebuzzTransaction.findOne().sort({ uploadDate: -1, createdAt: -1 }).lean();
    if (!last) return res.json({ deleted: 0 });

    let deleted = 0;

    if (last.uploadBatchId) {
      const r = await EasebuzzTransaction.deleteMany({ uploadBatchId: last.uploadBatchId });
      deleted = r.deletedCount || 0;
    } else if (last.uploadDate) {
      // fallback for very old rows
      const t = new Date(last.uploadDate).getTime();
      const start = new Date(t - 2 * 60 * 1000);
      const end = new Date(t + 2 * 60 * 1000);
      const r = await EasebuzzTransaction.deleteMany({ uploadDate: { $gte: start, $lte: end } });
      deleted = r.deletedCount || 0;
    }

    return res.json({ deleted });
  } catch (err) {
    console.error("delete-last-upload error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// ------------------- GET /sample -------------------
router.get("/sample", (req, res) => {
  const header =
    "S. No.,Transaction Type,Payment Id,Order Id,Amount,Currency,Tax,Fee,Additional Fees,Additional Tax,Debit,gokwik Deduction,Credit,Payment Method,Transaction Date,Transaction RRN,Merchant Order Id,Shopify Order Id,Shopify Transaction Id,Settlement UTR,Settlement Date,Settled By,Payment Mode,Bank Code,Card Network\n";

  const row =
    "1,payment,pay_123,MA12345,1000,INR,0,0,0,0,0,0,1000,UPI,2026-02-16,RRN123,MO123,SO123,STX123,UTR123,2026-02-18,Easebuzz,UPI,HDFC,VISA\n";

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="easebuzz_sample.csv"');
  res.send(header + row);
});

module.exports = router;
