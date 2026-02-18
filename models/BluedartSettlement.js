// models/BluedartSettlement.js
const mongoose = require("mongoose");

const bluedartSettlementSchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, default: Date.now, index: true }, 
    uploadBatchId: { type: String, index: true },

    awbNo: { type: String, default: "" }, 
    dpuDate: { type: Date, default: null },
    processDate: { type: Date, default: null },
    settledDate: { type: Date, default: null },

    orderId: { type: String, default: "" },
    portalName: { type: String, default: "" },
    customerPayAmt: { type: Number, default: 0 },
    utr: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BluedartSettlement", bluedartSettlementSchema);
