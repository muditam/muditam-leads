const mongoose = require("mongoose");

const Capital6389TxnSchema = new mongoose.Schema(
  {
    txnDate: { type: Date },
    valueDate: { type: Date },
    description: { type: String },
    refNo: { type: String },
    branchCode: { type: String },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    remarks: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Capital6389Txn", Capital6389TxnSchema);
