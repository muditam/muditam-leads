const mongoose = require("mongoose");

const Cc1101TxnSchema = new mongoose.Schema(
  {
    date: { type: Date },                 // Date
    valueDate: { type: Date },            // Value Date
    description: { type: String },        // Description
    refNo: { type: String },              // Ref No./Cheque No.
    branchCode: { type: String },         // Branch Code
    debit: { type: Number, default: 0 },  // Debit
    credit: { type: Number, default: 0 }, // Credit
    balance: { type: Number, default: 0 },// Balance
    remarks: { type: String },            // Remarks (from last Remarks col)
    rowColor: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Cc1101Txn", Cc1101TxnSchema);
