// routes/paymentRcrds.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const AWS = require("aws-sdk");
const mongoose = require("mongoose");


const PaymentRcrd = require("../models/PaymentRcrd");
const PurchaseRcrd = require("../models/PurchaseRcrd"); // ✅ make sure filename matches
const Vendor = require("../models/Vendorname");


const upload = multer({ storage: multer.memoryStorage() });


// Wasabi S3
const s3 = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  s3ForcePathStyle: true,
});


function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}


async function resolveVendor({ vendorId, vendorName }) {
  const id = String(vendorId || "").trim();
  const name = String(vendorName || "").trim();


  if (id) {
    if (!isValidObjectId(id)) return null;
    const v = await Vendor.findById(id, { _id: 1, name: 1 }).lean();
    return v ? { _id: v._id, name: v.name } : null;
  }


  if (name) {


    const v = await Vendor.findOne(
      { name: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") },
      { _id: 1, name: 1 }
    ).lean();
    return v ? { _id: v._id, name: v.name } : { _id: null, name }; // allow name-only snapshot
  }


  return null;
}


function vendorMatchFilter(vendor) {


  const or = [];
  if (vendor?._id) {
    or.push({ vendorId: vendor._id });


    or.push({ vendorId: String(vendor._id) });
  }
  if (vendor?.name) {
    or.push({ vendorName: new RegExp(`^\\s*${vendor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") });
  }
  return or.length ? { $or: or } : {};
}


router.get("/", async (req, res) => {
  try {
    const records = await PaymentRcrd.find({ isDeleted: { $ne: true } }).sort({ date: -1 });
    res.json(records);
  } catch (err) {
    console.error("GET /payment-records error:", err);
    res.status(500).json({ error: "Failed to fetch payment records" });
  }
});
router.get("/calc-due", async (req, res) => {
  try {
    const { date, amountPaid, vendorId, vendorName } = req.query;
    if (!date) return res.status(400).json({ error: "Date required" });


    const vendor = await resolveVendor({ vendorId, vendorName });
    if (!vendor) return res.status(400).json({ error: "Vendor required" });


    const amt = Number(amountPaid || 0);
    const dayEnd = new Date(String(date).slice(0, 10) + "T23:59:59.999Z");


    const vMatch = vendorMatchFilter(vendor);


    const purchases = await PurchaseRcrd.aggregate([
      { $match: { ...vMatch, date: { $lte: dayEnd }, isDeleted: { $ne: true } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);


    const payments = await PaymentRcrd.aggregate([
      { $match: { ...vMatch, date: { $lte: dayEnd }, isDeleted: { $ne: true } } },
      { $group: { _id: null, total: { $sum: "$amountPaid" } } },
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


router.post("/", async (req, res) => {
  try {
    const { date, vendorId, vendorName, amountPaid, screenshotUrl } = req.body;


    if (!date) return res.status(400).json({ error: "Date required" });
    if (!amountPaid || Number(amountPaid) <= 0) return res.status(400).json({ error: "amountPaid must be > 0" });


    const vendor = await resolveVendor({ vendorId, vendorName });
    if (!vendor) return res.status(400).json({ error: "Vendor required" });


    const d = String(date).slice(0, 10);
    const dayEnd = new Date(d + "T23:59:59.999Z");
    const vMatch = vendorMatchFilter(vendor);


    const purchases = await PurchaseRcrd.aggregate([
      { $match: { ...vMatch, date: { $lte: dayEnd }, isDeleted: { $ne: true } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);


    const payments = await PaymentRcrd.aggregate([
      { $match: { ...vMatch, date: { $lte: dayEnd }, isDeleted: { $ne: true } } },
      { $group: { _id: null, total: { $sum: "$amountPaid" } } },
    ]);


    const totalPurchases = purchases[0]?.total || 0;
    const totalPayments = payments[0]?.total || 0;


    const due = totalPurchases - totalPayments - Number(amountPaid || 0);


    const record = await PaymentRcrd.create({
      date: new Date(d + "T00:00:00.000Z"),
      vendorId: vendor._id || null,
      vendorName: vendor.name || "",
      amountPaid: Number(amountPaid),
      due,
      screenshotUrl: String(screenshotUrl || ""),
      isDeleted: false,
    });


    res.json(record);
  } catch (err) {
    console.error("POST /payment error:", err);
    res.status(500).json({ error: "Failed to add payment record" });
  }
});
router.post("/upload-screenshot", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });


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



