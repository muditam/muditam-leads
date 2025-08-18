const mongoose = require("mongoose");

const dtdcSchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },
  cnNumber: String,
  customerReferenceNumber: String,
  bookingDate: String,
  deliveryDate: String,
  codAmount: Number,
  remittedAmount: Number,
  remittanceStatus: String,
  utrNumber: String,
  remittanceDate: String,
});

module.exports = mongoose.model("DtdcSettlement", dtdcSchema);
