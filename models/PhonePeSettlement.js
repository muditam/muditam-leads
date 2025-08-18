const mongoose = require("mongoose");

const phonePeSettlementSchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },
  merchantId: String,
  transactionType: String,
  merchantOrderId: String,
  merchantReferenceId: String,
  phonePeReferenceId: String,
  phonePeTransactionReferenceId: String,
  phonePeAttemptReferenceId: String,
  transactionUTR: String,
  totalTransactionAmount: Number,
  transactionDate: String,
  transactionStatus: String,
  upiAmount: Number,
  walletAmount: Number,
  creditCardAmount: Number,
  debitCardAmount: Number,
  externalWalletAmount: Number,
  egvAmount: Number,
  storeId: String,
  terminalId: String,
  storeName: String,
  terminalName: String,
  errorCode: String,
  detailedErrorCode: String,
  errorDescription: String,
  errorSource: String,
  errorStage: String,
});

module.exports = mongoose.model("PhonePeSettlement", phonePeSettlementSchema);
