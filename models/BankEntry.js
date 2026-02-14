// models/BankEntry.js
const mongoose = require("mongoose");

const BankEntrySchema = new mongoose.Schema(
  {
    // Two "Value Date" columns -> store as valueDate (posting/ledger) and txnDate
    valueDate: { type: Date, default: null },
    txnDate: { type: Date, default: null },

    description: { type: String, default: "" },
    refNoChequeNo: { type: String, default: "" },
    branchCode: { type: String, default: "" },

    debit: { type: Number, default: null },
    credit: { type: Number, default: null },
    balance: { type: Number, default: null },
 
    remark: { type: String, default: "" },
    orderIds: { type: String, default: "" },
    remarks3: { type: String, default: "" },

    // NEW: persisted row background color (for “red/green” swatches etc.)
    rowColor: { type: String, default: "" },
  },
  { timestamps: true }
);

// Useful indexes
BankEntrySchema.index({ valueDate: -1 });
BankEntrySchema.index({ txnDate: -1 });
BankEntrySchema.index({ refNoChequeNo: 1 });
BankEntrySchema.index({ branchCode: 1 });

module.exports = mongoose.model("BankEntry", BankEntrySchema);
