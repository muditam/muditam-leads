// routes/paymentRcrds.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const AWS = require("aws-sdk");

const PaymentRcrd = require("../models/PaymentRcrd");
const PurchaseRcrd = require("../models/PurchaseRcrd");

// Upload middleware
const upload = multer({ storage: multer.memoryStorage() });

// Wasabi S3
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});

// ------------------------------------------------------
// GET ALL PAYMENT RECORDS
// ------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const records = await PaymentRcrd.find({ isDeleted: { $ne: true } })
      .sort({ date: -1 });
    res.json(records);
  } catch (err) {
    console.error("GET /payment-records error:", err);
    res.status(500).json({ error: "Failed to fetch payment records" });
  }
});

// ------------------------------------------------------
// LIVE DUE CALCULATION (NO SAVE)
// ------------------------------------------------------
router.get("/calc-due", async (req, res) => {
  try {
    const { date, amountPaid } = req.query;
    if (!date) return res.status(400).json({ error: "Date required" });

    const amt = Number(amountPaid || 0);

    const dayStart = new Date(date + "T00:00:00.000Z");
    const dayEnd = new Date(date + "T23:59:59.999Z");

    const purchases = await PurchaseRcrd.aggregate([
      { $match: { date: { $gte: dayStart, $lte: dayEnd }, isDeleted: { $ne: true } }},
      { $group: { _id: null, total: { $sum: "$amount" }}}
    ]);

    const payments = await PaymentRcrd.aggregate([
      { $match: { date: { $gte: dayStart, $lte: dayEnd }, isDeleted: { $ne: true } }},
      { $group: { _id: null, total: { $sum: "$amountPaid" }}}
    ]);

    const totalPurchases = purchases[0]?.total || 0;
    const totalPayments = payments[0]?.total || 0;

    const due = totalPurchases - totalPayments - amt;

    res.json({ due });
  } catch (err) {
    console.error("Calc Due Error:", err);
    res.status(500).json({ error: "Failed to calculate due" });
  }
});

// ------------------------------------------------------
// SAVE PAYMENT RECORD
// ------------------------------------------------------
router.post("/", async (req, res) => {
  try {
    const { date, vendorId, vendorName, amountPaid, screenshotUrl } = req.body;

    const currentDate = new Date(date);

    // Final due calculation for saved record
    const purchases = await PurchaseRcrd.aggregate([
      { $match: { date: { $lte: currentDate }, isDeleted: { $ne: true } }},
      { $group: { _id: null, total: { $sum: "$amount" }}}
    ]);

    const payments = await PaymentRcrd.aggregate([
      { $match: { date: { $lte: currentDate }, isDeleted: { $ne: true } }},
      { $group: { _id: null, total: { $sum: "$amountPaid" }}}
    ]);

    const totalPurchases = purchases[0]?.total || 0;
    const totalPayments = payments[0]?.total || 0;

    const due = totalPurchases - totalPayments - Number(amountPaid || 0);

    const record = await PaymentRcrd.create({
      date,
      vendorId,
      vendorName,
      amountPaid,
      due,
      screenshotUrl,
    });

    res.json(record);
  } catch (err) {
    console.error("POST /payment error:", err);
    res.status(500).json({ error: "Failed to add payment record" });
  }
});

// ------------------------------------------------------
// SCREENSHOT UPLOAD TO WASABI
// ------------------------------------------------------
router.post("/upload-screenshot", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded" });

    const file = req.file;

    const params = {
      Bucket: process.env.WASABI_BUCKET,
      Key: `payment-screenshots/${Date.now()}_${file.originalname}`,
      Body: file.buffer,
      ACL: "public-read",
      ContentType: file.mimetype,
    };

    const uploaded = await s3.upload(params).promise();

    res.json({ url: uploaded.Location });
  } catch (err) {
    console.error("Upload Screenshot Error:", err);
    res.status(500).json({ error: "Screenshot upload failed" });
  }
});

// ------------------------------------------------------
// SOFT DELETE
// ------------------------------------------------------
router.delete("/:id", async (req, res) => {
  try {
    const updated = await PaymentRcrd.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    console.error("DELETE payment error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

module.exports = router;
