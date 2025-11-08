const mongoose = require("mongoose");

const YesCcTejasvTxnSchema = new mongoose.Schema(
  {
    date: { type: Date },                 // Date
    type: { type: String },              // Type
    amount: { type: Number, default: 0 },// Amount
    dr: { type: String },                // Dr (e.g. DR/CR or flag)
    remarks: { type: String },           // Remarks
  },
  { timestamps: true }
);

module.exports = mongoose.model("YesCcTejasvTxn", YesCcTejasvTxnSchema);
