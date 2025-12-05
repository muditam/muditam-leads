// routes/purchaseRecords.js
const express = require("express");
const router = express.Router();

const PurchaseRecord = require("../models/PurchaseRecord");
const Vendor = require("../models/Vendor");

const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const AWS = require("aws-sdk");

// ----------------------
// MULTER TEMP FOLDER
// ----------------------
const upload = multer({ dest: "uploads/" });

// ----------------------
// WASABI S3 CONFIG
// ----------------------
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region: process.env.WASABI_REGION,
  s3ForcePathStyle: true,
});

// =======================================================
// 🆕 FIXED DATE PARSER (NO 1-DAY SHIFT)
// =======================================================
function parseExcelLikeDate(input) {
  if (!input) return null;

  const parts = String(input).trim().split("-");
  if (parts.length === 3) {
    const d = parseInt(parts[0], 10);
    const mStr = parts[1].trim().substring(0, 3).toLowerCase();
    const y = parseInt(parts[2], 10);

    const monthMap = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const month = monthMap[mStr];

    if (month !== undefined && !isNaN(d) && !isNaN(y)) {
      return new Date(y, month, d, 12, 0, 0);
    }
  }

  const fallback = new Date(input);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// =======================================================
// NORMALIZE CATEGORY (Commission → Commision)
// =======================================================
function normalizeCategory(cat) {
  if (!cat) return cat;
  const c = cat.trim().toLowerCase();
  if (c === "commission" || c === "commision") return "Commision";
  return cat;
}

// =======================================================
// 1️⃣ UPLOAD INVOICE → WASABI
// =======================================================
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const fileContent = fs.readFileSync(req.file.path);
    const fileName = `purchase-records/${Date.now()}-${req.file.originalname}`;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: fileName,
      Body: fileContent,
      ContentType: req.file.mimetype,
      ACL: "public-read",
    };

    const uploadResult = await s3.upload(params).promise();
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: "File uploaded successfully",
      url: uploadResult.Location,
      key: uploadResult.Key,
    });
  } catch (error) {
    console.error("Upload error:", error.message);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =======================================================
// 2️⃣ GET PURCHASE RECORDS (PAGINATION)
// =======================================================
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const records = await PurchaseRecord.find()
      .populate("vendorId", "name email")
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await PurchaseRecord.countDocuments();

    res.json({ records, total, page, pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("Fetch purchase records error:", error.message);
    res.status(500).json({ message: "Failed to fetch records", error: error.message });
  }
});

// =======================================================
// 3️⃣ CREATE PURCHASE RECORD
// =======================================================
router.post("/", async (req, res) => {
  try {
    const {
      date,
      category,
      invoiceType,
      billingGST,
      invoiceNo,
      vendorId,
      vendorName,
      amount,
      invoiceLink,
      matched2B,
      invoicingTally,
    } = req.body;

    // Basic required field check (matches schema)
    if (!date || !category || !vendorId || !vendorName || !invoiceNo) {
      return res
        .status(400)
        .json({ message: "Missing required fields (date, category, vendor, invoiceNo)" });
    }

    const newRecord = new PurchaseRecord({
      date: new Date(date),
      category: normalizeCategory(category),
      invoiceType: invoiceType || "",
      billingGST: billingGST || "",
      invoiceNo: String(invoiceNo).trim(),
      vendorId,
      vendorName,
      amount: Number(amount) || 0,
      invoiceLink: invoiceLink || "",
      matched2B: !!matched2B,
      invoicingTally: !!invoicingTally,
    });

    const saved = await newRecord.save();
    const populated = await PurchaseRecord.findById(saved._id).populate(
      "vendorId",
      "name email"
    );

    res
      .status(201)
      .json({ record: populated, message: "Record created successfully" });
  } catch (error) {
    console.error("Create purchase record error:", error.message);
    res.status(500).json({ message: "Failed to create record", error: error.message });
  }
});

// =======================================================
// 4️⃣ UPDATE PURCHASE RECORD
// =======================================================
router.put("/:id", async (req, res) => {
  try {
    const update = {
      date: req.body.date ? new Date(req.body.date) : undefined,
      category: normalizeCategory(req.body.category),
      invoiceType: req.body.invoiceType,
      billingGST: req.body.billingGST,
      invoiceNo: req.body.invoiceNo ? String(req.body.invoiceNo).trim() : undefined,
      amount:
        req.body.amount !== undefined ? Number(req.body.amount) : undefined,
      invoiceLink: req.body.invoiceLink,
      matched2B: req.body.matched2B,
      invoicingTally: req.body.invoicingTally,
    };

    Object.keys(update).forEach(
      (key) => update[key] === undefined && delete update[key]
    );

    const updated = await PurchaseRecord.findByIdAndUpdate(
      req.params.id,
      update,
      {
        new: true,
        runValidators: true,
      }
    ).populate("vendorId", "name email");

    if (!updated) {
      return res.status(404).json({ message: "Record not found" });
    }

    res.json({ record: updated, message: "Record updated successfully" });
  } catch (error) {
    console.error("Update purchase record error:", error.message);
    res.status(500).json({ message: "Failed to update record", error: error.message });
  }
});

// =======================================================
// 5️⃣ DELETE PURCHASE RECORD (HARD DELETE)
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await PurchaseRecord.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Record not found" });
    }

    res.json({ message: "Record deleted successfully" });
  } catch (error) {
    console.error("Delete purchase record error:", error.message);
    res.status(500).json({ message: "Failed to delete record", error: error.message });
  }
});

// =======================================================
// 6️⃣ GET VENDORS
// =======================================================
router.get("/vendors", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 2000;

    const vendors = await Vendor.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    const total = await Vendor.countDocuments();

    res.json({ vendors, total });
  } catch (error) {
    console.error("Fetch vendors error:", error.message);
    res.status(500).json({ message: "Failed to fetch vendors", error: error.message });
  }
});

// =======================================================
// 7️⃣ CREATE VENDOR
// =======================================================
router.post("/vendors", async (req, res) => {
  try {
    const { name, email, phoneNumber, hasGST, gstNumber } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Vendor name is required" });
    }

    const existing = await Vendor.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
    });

    if (existing) {
      return res
        .status(200)
        .json({ vendor: existing, message: "Vendor already exists" });
    }

    const newVendor = new Vendor({
      name: name.trim(),
      email: email || "",
      phoneNumber: phoneNumber || "",
      hasGST: hasGST !== undefined ? hasGST : true,
      gstNumber: gstNumber || "",
    });

    const saved = await newVendor.save();
    res
      .status(201)
      .json({ vendor: saved, message: "Vendor created successfully" });
  } catch (error) {
    console.error("Create vendor error:", error.message);
    res.status(500).json({ message: "Failed to create vendor", error: error.message });
  }
});

// =======================================================
// 8️⃣ BULK CSV UPLOAD - FIXED
// =======================================================
router.post("/upload-csv", upload.single("file"), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    filePath = req.file.path;
    const rows = [];
    const errors = [];

    const stream = fs
      .createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("error", (err) => {
        console.error("CSV read error:", err.message);
      })
      .on("end", async () => {
        let inserted = 0;

        // CRITICAL FIX: Process each row with error recovery
        for (let row of rows) {
          try {
            const norm = {};
            for (let key in row) {
              const cleanKey = key
                .toLowerCase()
                .replace(/\./g, "")
                .replace(/\s+/g, "_")
                .trim();
              norm[cleanKey] = String(row[key]).trim();
            }

            const vendorName = norm.vendor_name || norm.vendorname;
            if (!vendorName) {
              errors.push({ row, error: "Vendor Name missing" });
              continue; // CRITICAL: Continue instead of throw
            }

            let vendor = null;
            try {
              vendor = await Vendor.findOne({
                name: { $regex: new RegExp(`^${vendorName}$`, "i") },
              });
            } catch (findErr) {
              console.error("Vendor find error:", findErr.message);
              errors.push({ row, error: "Vendor lookup failed" });
              continue;
            }

            if (!vendor) {
              try {
                vendor = await Vendor.create({
                  name: vendorName,
                  email: norm.vendor_email || "",
                  phoneNumber: (norm.vendor_phone || "").replace(/\D/g, ""),
                  hasGST: true,
                  gstNumber: norm.gstnumber || "",
                });
              } catch (createErr) {
                console.error("Vendor create error:", createErr.message);
                errors.push({ row, error: "Failed to create vendor: " + createErr.message });
                continue; // CRITICAL: Continue instead of crash
              }
            }

            const parsedDate = parseExcelLikeDate(norm.date || norm.invoice_date);
            if (!parsedDate || isNaN(parsedDate.getTime())) {
              errors.push({ row, error: "Invalid Date" });
              continue;
            }

            const category = normalizeCategory(norm.category);

            const amountRaw = norm.invoice_amount || norm.amount || norm.invoiceamount || "0";
            const amount = Number(amountRaw.replace(/[^0-9.]/g, ""));
            
            if (isNaN(amount)) {
              errors.push({ row, error: "Invalid Amount" });
              continue;
            }

            // CRITICAL FIX: Wrap create in try-catch
            try {
              await PurchaseRecord.create({
                date: parsedDate,
                category,
                invoiceType: norm.invoice_type || "",
                billingGST: norm.billing_gst || "",
                invoiceNo: norm.invoice_no || "",
                vendorId: vendor._id,
                vendorName: vendor.name,
                amount,
                invoiceLink: norm.invoice_link || "",
                matched2B: norm.matched_with_2b?.toLowerCase() === "yes",
                invoicingTally: norm.invoicing_tally?.toLowerCase() === "yes",
              });

              inserted++;
            } catch (createErr) {
              console.error("Record create error:", createErr.message);
              errors.push({ row, error: "Failed to create record: " + createErr.message });
            }
          } catch (rowErr) {
            console.error("Row processing error:", rowErr.message);
            errors.push({ row, error: rowErr.message });
          }
        }

        // CRITICAL: Always cleanup file
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (unlinkErr) {
            console.error("Failed to delete temp file:", unlinkErr.message);
          }
        }

        return res.json({
          inserted,
          total: rows.length,
          errors: errors.length,
          errorDetails: errors.slice(0, 10),
        });
      });
  } catch (err) {
    console.error("Bulk upload error:", err.message);
    
    // CRITICAL: Cleanup file even on error
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        console.error("Failed to delete temp file:", unlinkErr.message);
      }
    }
    
    res.status(500).json({ 
      message: "Bulk upload failed", 
      error: err.message 
    });
  }
});

module.exports = router;