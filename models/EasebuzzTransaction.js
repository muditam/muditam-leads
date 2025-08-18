const mongoose = require("mongoose");

const easebuzzTransactionSchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, default: Date.now },
 
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
    settlementDate: String,
    settledBy: String,
    paymentMode: String,
    bankCode: String,
    cardNetwork: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("EasebuzzTransaction", easebuzzTransactionSchema);
