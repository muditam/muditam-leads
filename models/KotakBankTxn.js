const mongoose = require("mongoose");

const KotakBankTxnSchema = new mongoose.Schema(
  {
    slNo: { type: Number, default: null },

    transactionDate: { type: Date, default: null },
    valueDate: { type: Date, default: null },

    description: { type: String, default: "" },
    chqRefNo: { type: String, default: "" },

    amount: { type: Number, default: null },
    amountDrCr: { type: String, default: "" }, // first Dr/Cr (near Amount)

    balance: { type: Number, default: null },
    balanceDrCr: { type: String, default: "" }, // second Dr/Cr (near Balance)

    remarks: { type: String, default: "" },

    rowColor: { type: String, default: "" }, // used for row highlighting
  },
  { timestamps: true }
);

KotakBankTxnSchema.index({ valueDate: -1, createdAt: -1 });
KotakBankTxnSchema.index({ transactionDate: -1, createdAt: -1 });

module.exports = mongoose.model("KotakBankTxn", KotakBankTxnSchema);
