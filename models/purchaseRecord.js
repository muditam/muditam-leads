// models/PurchaseRecord.js
const mongoose = require("mongoose");


const CATEGORY_ENUM = [
  "Advertisement",
  "Assets",
  "Assets (Intangible)",
  "Bank Charges",
  "COGS",
  "Commision",          // match frontend spelling
  "Freight Inwards",
  "Marketing",
  "Operating Expense",
  "Packaging Material",
  "Professional Charges",
  "Services",
  "Software & Tools",
  "Travel Expense",
  "Freight Outwards",
  "Stock transfer",
  "Other",
];


const INVOICE_TYPE_ENUM = ["Credit Note", "Tax Invoice", "Debit Note"];


const BILLING_GST_ENUM = [
  "Himachal Pradesh",
  "Delhi",
  "Maharashtra",
  "Tamil Nadu",
  "Haryana",
  "West Bengal",
];


const PurchaseRecordSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },


    category: {
      type: String,
      required: true,
      enum: CATEGORY_ENUM,
      index: true,
    },


    // ✅ not required, so blur-save works even if user doesn't set it
    invoiceType: {
      type: String,
      enum: INVOICE_TYPE_ENUM,
      default: "",
    },


    // ✅ not required, so it can be blank too
    billingGST: {
      type: String,
      enum: BILLING_GST_ENUM,
      default: "",
    },


    invoiceNo: {
      type: String,
      required: true,
      trim: true,
    },


    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
      index: true,
    },


    vendorName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },


    amount: {
      type: Number,
      required: true,
      min: 0,
    },


    invoiceLink: {
      type: String,
      default: "",
      trim: true,
    },


    matched2B: {
      type: Boolean,
      default: false,
    },


    invoicingTally: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);


// Useful compound / text indexes
PurchaseRecordSchema.index({ vendorName: "text", invoiceNo: "text" });
PurchaseRecordSchema.index({ date: -1, category: 1 });
PurchaseRecordSchema.index({ vendorId: 1, date: -1 });


const PurchaseRecord = mongoose.model("PurchaseRecord", PurchaseRecordSchema);
module.exports = PurchaseRecord;



