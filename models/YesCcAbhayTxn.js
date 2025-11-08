const mongoose = require("mongoose");

const YesCcAbhayTxnSchema = new mongoose.Schema(
  {
    date: { type: Date },                  // Date
    transactionDetails: { type: String },  // Transaction Details
    amount: { type: Number, default: 0 },  // Amount (Rs.)
    drCr: { type: String },                // Dr/Cr
    balance: { type: Number, default: 0 }, // Balance
    remarks: { type: String },             // Remarks
  },
  { timestamps: true }
);

module.exports = mongoose.model("YesCcAbhayTxn", YesCcAbhayTxnSchema);
