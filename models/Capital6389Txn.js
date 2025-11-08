const mongoose = require("mongoose");

const Capital6389TxnSchema = new mongoose.Schema(
  {
    txnDate: { type: Date },              // Txn Date
    valueDate: { type: Date },            // Value Date
    description: { type: String },        // Description
    refNo: { type: String },              // Ref No./Cheque No.
    branchCode: { type: String },         // Branch Code
    debit: { type: Number, default: 0 },  // Debit
    credit: { type: Number, default: 0 }, // Credit
    balance: { type: Number, default: 0 },// Balance
    remarks: { type: String },            // Remarks (manual notes later)
  },
  { timestamps: true }
);

module.exports = mongoose.model("Capital6389Txn", Capital6389TxnSchema);
