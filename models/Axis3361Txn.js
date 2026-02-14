const mongoose = require("mongoose");

const Axis3361TxnSchema = new mongoose.Schema(
  {
    tranDate: { type: Date },              // Tran Date
    valueDate: { type: Date },             // Value Date
    chqNo: { type: String },               // CHQNO
    particulars: { type: String },         // Transaction Particulars
    amount: { type: Number, default: 0 },  // Amount(INR)
    drCr: { type: String },                // DR|CR
    balance: { type: Number, default: 0 }, // Balance(INR)
    branchName: { type: String },          // Branch Name
    remark: { type: String },              // Remark
    rowColor: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Axis3361Txn", Axis3361TxnSchema);
