const mongoose = require("mongoose");

const dtdcSchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, default: Date.now, index: true }, 
    uploadBatchId: { type: String, index: true },

    cnNumber: String,
    customerReferenceNumber: String,
    bookingDate: String, 
    deliveryDate: String,
    codAmount: Number,
    remittedAmount: Number,
    remittanceStatus: String,
    utrNumber: String,
    remittanceDate: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("DtdcSettlement", dtdcSchema);
 