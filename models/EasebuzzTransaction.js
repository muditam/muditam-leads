const mongoose = require("mongoose");

const easebuzzTransactionSchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, default: Date.now },
 
    uploadBatchId: { type: String, default: "" },

    serialNo: String,
    transactionType: String,
    paymentId: String,
    orderId: String,

    amount: Number,
    currency: String,
    tax: Number,
    fee: Number,
    additionalFees: Number,
    additionalTax: Number,
    debit: Number,
    gokwikDeduction: Number,
    credit: Number,

    paymentMethod: String,
    transactionDate: String,
    transactionRRN: String,

    merchantOrderId: String,
    shopifyOrderId: String,
    shopifyTransactionId: String,

    settlementUTR: String,
 
    settlementDate: Date,

    settledBy: String,
    paymentMode: String,
    bankCode: String,
    cardNetwork: String,
  },
  { timestamps: true }
);
 
easebuzzTransactionSchema.index({ uploadDate: -1 });
easebuzzTransactionSchema.index({ uploadBatchId: 1 });
easebuzzTransactionSchema.index({ orderId: 1 });
easebuzzTransactionSchema.index({ paymentId: 1 });
easebuzzTransactionSchema.index({ settlementUTR: 1 });

module.exports = mongoose.model("EasebuzzTransaction", easebuzzTransactionSchema);
