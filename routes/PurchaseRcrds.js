// routes/purchase-records.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const AWS = require("aws-sdk");
const mongoose = require("mongoose");


const PurchaseRecord = require("../models/PurchaseRcrd");
const Vendor = require("../models/Vendorname");


// ----------------------
// MULTER SETUP
// ----------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});


// ----------------------
// WASABI S3 CONFIG
// ----------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});


// ----------------------
// HELPERS
// ----------------------
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function normalizeVendorKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}


// matches vendorName robustly even if spaces/case differ a bit
function vendorNameFlexibleRegex(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const pattern = `^\\s*${parts.map(escapeRegExp).join("\\s+")}\\s*$`;
  return new RegExp(pattern, "i");
}


function parsePageLimit(req) {
  const pageRaw = req.query.page;
  const limitRaw = req.query.limit;


  const page = Number.isFinite(Number(pageRaw)) ? Math.max(0, parseInt(pageRaw, 10)) : 0;
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(200, Math.max(1, parseInt(limitRaw, 10))) : 10;


  return { page, limit };
}


function dayRangeUTC(yyyyMmDd) {
  const start = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  const end = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}


function parseBoolean(val) {
  if (val === true) return true;
  if (!val) return false;
  const s = String(val).toLowerCase().trim();
  return ["yes", "true", "1", "y"].includes(s);
}


function parseAmount(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;


  const s = String(val).trim();
  if (!s) return 0;


  const cleaned = s.replace(/[,₹\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}


function normalizeDate(val, fallback) {
  if (!val) return fallback;


  if (val instanceof Date && !Number.isNaN(val.getTime())) return val;


  if (typeof val === "number") {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
    return fallback;
  }


  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return fallback;


    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(`${s}T00:00:00.000Z`);
    }


    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }


  return fallback;
}


// ----------------------
// ✅ FAST VENDOR CACHE (smooth filters + bulk upload)
// ----------------------
const VENDOR_CACHE_TTL_MS = 60 * 1000; // 1 minute
let vendorCache = {
  at: 0,
  byKey: new Map(), // normalizedName -> vendor {_id,name}
};


async function refreshVendorCache(force = false) {
  const now = Date.now();
  if (!force && now - vendorCache.at < VENDOR_CACHE_TTL_MS && vendorCache.byKey.size) return vendorCache;


  const vendors = await Vendor.find({}, { _id: 1, name: 1 }).lean();
  const byKey = new Map();
  for (const v of vendors) byKey.set(normalizeVendorKey(v.name), v);


  vendorCache = { at: now, byKey };
  return vendorCache;
}


async function ensureVendorByName(nameRaw) {
  const name = String(nameRaw || "").trim();
  if (!name) return null;


  const cache = await refreshVendorCache(false);
  const key = normalizeVendorKey(name);


  // 1) quick cache hit
  const cached = cache.byKey.get(key);
  if (cached?._id) return cached;


  // 2) try DB find (flex match)
  const rx = vendorNameFlexibleRegex(name);
  let found = await Vendor.findOne(rx ? { name: rx } : { name }, { _id: 1, name: 1 }).lean();
  if (found?._id) {
    cache.byKey.set(normalizeVendorKey(found.name), found);
    return found;
  }


  // 3) create minimal vendor
  try {
    const created = await Vendor.create({
      name,
      phone: "",
      email: "",
      hasGST: false,
      gstNumber: "",
    });


    found = { _id: created._id, name: created.name };
    cache.byKey.set(normalizeVendorKey(found.name), found);
    return found;
  } catch (e) {
    // in case of race duplicates, re-find
    found = await Vendor.findOne(rx ? { name: rx } : { name }, { _id: 1, name: 1 }).lean();
    if (found?._id) {
      cache.byKey.set(normalizeVendorKey(found.name), found);
      return found;
    }
    return null;
  }
}


// Resolve vendorName/vendorId so data stays consistent (helps filtering + old rows)
async function resolveVendorFields(patch) {
  const out = { ...patch };


  const incomingVendorId = out.vendorId ?? null;
  const incomingVendorName = typeof out.vendorName === "string" ? out.vendorName.trim() : "";


  // If vendorId provided but vendorName missing → fill vendorName from DB
  if (incomingVendorId && !incomingVendorName) {
    const idStr = String(incomingVendorId);
    if (mongoose.Types.ObjectId.isValid(idStr)) {
      const v = await Vendor.findById(idStr, { name: 1 }).lean();
      if (v?.name) out.vendorName = v.name;
    }
  }


  // If vendorName provided but vendorId missing → ensure vendor exists & set vendorId
  if (!incomingVendorId && incomingVendorName) {
    const v = await ensureVendorByName(incomingVendorName);
    if (v?._id) out.vendorId = v._id;
    if (v?.name) out.vendorName = v.name; // canonical name
  }


  // If both provided → canonicalize vendorName from vendorId
  if (incomingVendorId && incomingVendorName) {
    const idStr = String(incomingVendorId);
    if (mongoose.Types.ObjectId.isValid(idStr)) {
      const v = await Vendor.findById(idStr, { name: 1 }).lean();
      if (v?.name) out.vendorName = v.name;
    }
  }


  // If vendorId explicitly set to null → also clear vendorName if not set
  if (incomingVendorId === null && !("vendorName" in out)) {
    out.vendorName = "";
  }


  return out;
}


// -----------------------------------------------------
// GET PURCHASE RECORDS (SERVER-SIDE FILTERS + PAGINATION)
// -----------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const { page, limit } = parsePageLimit(req);


    const showDeleted = String(req.query.showDeleted || "").toLowerCase() === "true";


    const vendorId = String(req.query.vendorId || "").trim();
    const vendorName = String(req.query.vendorName || "").trim();
    const invoiceNo = String(req.query.invoiceNo || "").trim();
    const amountRaw = String(req.query.amount ?? "").trim();
    const dateRaw = String(req.query.date || "").trim(); // YYYY-MM-DD
    const billingGSTRaw = String(req.query.billingGST || "").trim();




    const and = [];


    and.push(showDeleted ? { isDeleted: true } : { isDeleted: { $ne: true } });


    if (vendorId || vendorName) {
      const vendorOr = [];


      if (vendorId) {
        if (!mongoose.Types.ObjectId.isValid(vendorId)) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const oid = new mongoose.Types.ObjectId(vendorId);
        vendorOr.push({ vendorId: oid });
        vendorOr.push({ vendorId: vendorId }); // old string stored
      }


      if (vendorName) {
        const rx = vendorNameFlexibleRegex(vendorName);
        if (rx) vendorOr.push({ vendorName: rx });
        else vendorOr.push({ vendorName: vendorName });
      }


      if (vendorOr.length === 1) and.push(vendorOr[0]);
      else if (vendorOr.length > 1) and.push({ $or: vendorOr });
    }


    if (invoiceNo) {
      and.push({ invoiceNo: { $regex: escapeRegExp(invoiceNo), $options: "i" } });
    }


if (amountRaw !== "") {
  const n = parseAmount(amountRaw);


  if (Number.isFinite(n)) {
    and.push({ amount: n });
  }
}


if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
  const { start, end } = dayRangeUTC(dateRaw);


  and.push({
    $or: [
      { date: { $gte: start, $lt: end } },
      { date: dateRaw },
    ],
  });
}
if (billingGSTRaw) {
  and.push({
    billingGST: new RegExp(`^${escapeRegExp(billingGSTRaw)}$`, "i"),
  });
}




    const query = and.length ? { $and: and } : {};
    const skip = page * limit;


    const [items, total] = await Promise.all([
      PurchaseRecord.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PurchaseRecord.countDocuments(query),
    ]);


    const hasMore = skip + items.length < total;
    return res.json({ items, total, page, limit, hasMore });
  } catch (err) {
    console.error("GET /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to fetch purchase records" });
  }
});
router.post("/", async (req, res) => {
  try {
    const payload = await resolveVendorFields(req.body || {});
    if ("amount" in payload) payload.amount = parseAmount(payload.amount);
    const created = await PurchaseRecord.create(payload);
    return res.json(created);
  } catch (err) {
    console.error("POST /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to create purchase record" });
  }
});


router.patch("/:id", async (req, res) => {
  try {
    const patch = await resolveVendorFields(req.body || {});
    if ("amount" in patch) patch.amount = parseAmount(patch.amount); // ✅ normalize


    const updated = await PurchaseRecord.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!updated) return res.status(404).json({ error: "Record not found" });
    return res.json(updated);
  } catch (err) {
    console.error("PATCH /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to update purchase record" });
  }
});


router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );


    if (!deleted) return res.status(404).json({ error: "Record not found" });
    return res.json(deleted);
  } catch (err) {
    console.error("DELETE /api/purchase-records error:", err);
    return res.status(500).json({ error: "Failed to delete record" });
  }
});




router.post("/upload-invoice", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });


    const file = req.file;


    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: `purchase-invoices/${Date.now()}_${file.originalname}`,
      Body: file.buffer,
      ACL: "public-read",
      ContentType: file.mimetype,
    };


    const uploaded = await s3.upload(params).promise();
    return res.json({ url: uploaded.Location });
  } catch (err) {
    console.error("Invoice Upload Error:", err);
    return res.status(500).json({ error: "Failed to upload invoice" });
  }
});


router.post("/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });


    await refreshVendorCache(true);


    const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });


    const defaultDate = req.body.date
      ? new Date(`${String(req.body.date).slice(0, 10)}T00:00:00.000Z`)
      : new Date();


    // 1) collect unique vendor names from file
    const uniqueNames = new Map(); // key -> originalName
    for (const r of rows) {
      const rawName = String(r["Vendor Name"] || "").trim();
      if (!rawName) continue;
      uniqueNames.set(normalizeVendorKey(rawName), rawName);
    }


    // 2) create missing vendors (fast)
    const cache = await refreshVendorCache(false);
    const missing = [];
    for (const [key, originalName] of uniqueNames.entries()) {
      if (!cache.byKey.has(key)) {
        missing.push({
          name: originalName,
          phone: "",
          email: "",
          hasGST: false,
          gstNumber: "",
        });
      }
    }


    if (missing.length) {
      try {
        await Vendor.insertMany(missing, { ordered: false });
      } catch (e) {
        // ignore duplicates from races
        console.warn("Vendor bulk insert warning:", e?.message || e);
      }
      await refreshVendorCache(true);
    }


    // 3) build purchase docs with vendorId
    const cache2 = await refreshVendorCache(false);


    const docs = rows.map((r) => {
      const rawVendorName = String(r["Vendor Name"] || "").trim();
      const v = rawVendorName ? cache2.byKey.get(normalizeVendorKey(rawVendorName)) : null;


      return {
        date: normalizeDate(r["Date"], defaultDate),


        category: r["Category"] || "",
        invoiceType: r["Invoice Type"] || "",
        billingGST: r["Billing GST"] || "",
        invoiceNo: r["Invoice No"] || "",


        vendorName: v?.name || rawVendorName || "",
        vendorId: v?._id || null,


        amount: parseAmount(r["Amount"]),
        invoiceUrl: r["Invoice Link"] || "",
        matched2B: parseBoolean(r["Matched 2B"]),
        tally: parseBoolean(r["Tally"]),


        isDeleted: false,
      };
    });


    const inserted = await PurchaseRecord.insertMany(docs, { ordered: false });


    return res.json({
      success: true,
      count: inserted.length,
      records: inserted,
    });
  } catch (err) {
    console.error("Bulk Upload Error:", err);
    return res.status(500).json({ error: "Bulk upload failed" });
  }
});
module.exports = router;



