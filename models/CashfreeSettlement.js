// models/CashfreeSettlement.js
const mongoose = require("mongoose");

const CashfreeSettlementSchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, index: true },
    uploadBatchId: { type: String, index: true },

    orderId: { type: String, index: true, default: "" },
    amountReceived: { type: Number, default: 0 },

    dateOfPayment: { type: Date, default: null, index: true },
    transactionId: { type: String, index: true, default: "" },

    utrNo: { type: String, index: true, default: "" },
    dateOfSettlement: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

CashfreeSettlementSchema.index({ uploadDate: -1, createdAt: -1 });

module.exports = mongoose.model("CashfreeSettlement", CashfreeSettlementSchema);
