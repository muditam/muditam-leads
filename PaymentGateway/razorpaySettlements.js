// routes/razorpay.routes.js
const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const RazorpaySettlement = require("../models/RazorpaySettlement");

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, "..", "uploads", "razorpay"),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------------- helpers ----------------
const pick = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return undefined;
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(v) {
  if (v === undefined || v === null) return 0;
  let s = String(v).trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return 0;
  s = s.replace(/[,₹\s]/g, "");
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

// For filters: accept YYYY-MM-DD (from input[type=date]) and coerce to day start/end
function parseDateParam(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // handle YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const yyyy = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const dd = parseInt(m[3], 10);
    const d = new Date(yyyy, mm - 1, dd);
    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d;
  }

  // fallback
  const d2 = new Date(s);
  if (Number.isNaN(d2.getTime())) return null;
  if (endOfDay) d2.setHours(23, 59, 59, 999);
  else d2.setHours(0, 0, 0, 0);
  return d2;
}

// Razorpay CSV dates are often ISO strings in "Created At"/"Settled At".
// We keep them as strings in DB, but for filtering we parse these strings in query using regex (best effort)
// If your CSV is always ISO (YYYY-MM-DD...), we can filter with prefix match.
function buildIsoPrefixRange(fieldValue, min, max) {
  // For string dates like "2025-11-13T10:00:00Z"
  // min/max from YYYY-MM-DD
  const out = {};
  if (min) out.$gte = String(min); // not used
  if (max) out.$lte = String(max); // not used
  return out;
}

// ===================== UPLOAD CSV =====================
router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const results = [];
  const filePath = req.file.path;

  fs.createReadStream(filePath)
    .pipe(
      csv({
        mapHeaders: ({ header }) =>
          String(header || "")
            .replace(/\uFEFF/g, "")
            .replace(/\s+/g, " ")
            .trim(),
      })
    )
    .on("data", (row) => {
      const mapped = {
        uploadDate: new Date(),

        transaction_entity: pick(row, [
          "Transaction Entity",
          "Transaction entity",
          "transaction_entity",
        ]) || "",
        entity_id: pick(row, ["Entity ID", "Entity Id", "entity_id"]) || "",

        amount: toNumber(pick(row, ["Amount", "amount"])),
        currency: pick(row, ["Currency", "currency"]) || "",

        fee: toNumber(pick(row, ["Fee", "fee"])),
        tax: toNumber(pick(row, ["Tax", "tax"])),
        debit: toNumber(pick(row, ["Debit", "debit"])),
        credit: toNumber(pick(row, ["Credit", "credit"])),

        payment_method:
          pick(row, ["Payment Method", "Payment method", "payment_method"]) || "",
        card_type: pick(row, ["Card Type", "card_type"]) || "",
        issuer_name: pick(row, ["Issuer Name", "issuer_name"]) || "",

        entity_created_at:
          pick(row, ["Created At", "Created at", "entity_created_at"]) || "",

        order_id: pick(row, ["Order ID", "Order Id", "order_id"]) || "",

        settlement_id:
          pick(row, ["Settlemet Id", "Settlement Id", "settlement_id"]) || "",

        settlement_utr:
          pick(row, ["Settlement UTR", "Settlement Utr", "settlement_utr"]) || "",

        settled_at: pick(row, ["Settled At", "Settled at", "settled_at"]) || "",

        settled_by: pick(row, ["Settled By", "Settled by", "settled_by"]) || "",
      };

      results.push(mapped);
    })
    .on("end", async () => {
      try {
        if (!results.length) {
          fs.unlink(filePath, () => {});
          return res.status(400).json({ error: "CSV seems empty or invalid" });
        }

        await RazorpaySettlement.insertMany(results, { ordered: false });
        fs.unlink(filePath, () => {});
        return res.json({ message: "Upload successful", inserted: results.length });
      } catch (error) {
        console.error("DB Save Error:", error);
        fs.unlink(filePath, () => {});
        return res.status(500).json({ error: "Failed to save data" });
      }
    })
    .on("error", (err) => {
      console.error("CSV Parse Error:", err);
      fs.unlink(filePath, () => {});
      return res.status(500).json({ error: "Failed to parse CSV" });
    });
});

// ===================== GET PAGINATED DATA + FILTERS =====================
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
      createdMin,
      createdMax,
      settledMin,
      settledMax,
      amountMin,
      amountMax,
      feeMin,
      feeMax,
      taxMin,
      taxMax,
      paymentMethod,
      cardType,
      currency,
    } = req.query;

    const query = {};

    // text search
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      query.$or = [
        { entity_id: rx },
        { order_id: rx },
        { settlement_id: rx },
        { settlement_utr: rx },
        { issuer_name: rx },
        { payment_method: rx },
        { transaction_entity: rx },
      ];
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

    // created_at range (stored as string, so use ISO prefix matching if YYYY-MM-DD)
    // if your values are ISO, prefix filter is reliable.
    if (createdMin || createdMax) {
      const parts = [];
      if (createdMin) parts.push({ entity_created_at: new RegExp(`^${escapeRegex(createdMin)}`, "i") });
      if (createdMax) parts.push({ entity_created_at: new RegExp(`^${escapeRegex(createdMax)}`, "i") });
      // NOTE: This isn't true range; it's "starts with date".
      // If you want true range, store entity_created_at as Date in schema.
      if (parts.length === 1) Object.assign(query, parts[0]);
      if (parts.length === 2) query.$and = (query.$and || []).concat(parts);
    }

    // settled_at range (stored as string, same approach)
    if (settledMin || settledMax) {
      const parts = [];
      if (settledMin) parts.push({ settled_at: new RegExp(`^${escapeRegex(settledMin)}`, "i") });
      if (settledMax) parts.push({ settled_at: new RegExp(`^${escapeRegex(settledMax)}`, "i") });
      if (parts.length === 1) Object.assign(query, parts[0]);
      if (parts.length === 2) query.$and = (query.$and || []).concat(parts);
    }

    // numeric ranges
    const numRange = (field, minV, maxV) => {
      const mn = minV !== undefined && minV !== "" ? Number(minV) : null;
      const mx = maxV !== undefined && maxV !== "" ? Number(maxV) : null;
      if (mn === null && mx === null) return;
      query[field] = {};
      if (mn !== null && !Number.isNaN(mn)) query[field].$gte = mn;
      if (mx !== null && !Number.isNaN(mx)) query[field].$lte = mx;
      if (!Object.keys(query[field]).length) delete query[field];
    };

    numRange("amount", amountMin, amountMax);
    numRange("fee", feeMin, feeMax);
    numRange("tax", taxMin, taxMax);

    // contains filters
    if (paymentMethod && String(paymentMethod).trim()) {
      query.payment_method = new RegExp(escapeRegex(String(paymentMethod).trim()), "i");
    }
    if (cardType && String(cardType).trim()) {
      query.card_type = new RegExp(escapeRegex(String(cardType).trim()), "i");
    }
    if (currency && String(currency).trim()) {
      query.currency = new RegExp(`^${escapeRegex(String(currency).trim())}$`, "i");
    }

    const [data, total] = await Promise.all([
      RazorpaySettlement.find(query).skip(skip).limit(limit).sort({ uploadDate: -1, createdAt: -1 }).lean(),
      RazorpaySettlement.countDocuments(query),
    ]);

    return res.json({
      data,
      page,
      totalPages: Math.ceil(total / limit),
      totalRecords: total,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch records" });
  }
});

// ===================== SAMPLE CSV DOWNLOAD =====================
router.get("/sample", (req, res) => {
  const headerRow =
    "Upload Date,Transaction Entity,Entity ID,Amount,Currency,Fee,Tax,Debit,Credit,Payment Method,Card Type,Issuer Name,Created At,Order ID,Settlemet Id,Settlement UTR,Settled At,Settled By\n";

  const exampleRow =
    `${new Date().toISOString()},payment,pay_123ABC,1000,INR,20,3.6,0,1000,UPI,,HDFC Bank,2025-11-13T10:00:00Z,order_12345,settle_98765,UTR123456789,2025-11-14T12:00:00Z,Razorpay\n`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="razorpay_sample.csv"');
  res.send(headerRow + exampleRow);
});

module.exports = router;
