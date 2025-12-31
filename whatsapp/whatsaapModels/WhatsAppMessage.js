const mongoose = require("mongoose");

const WhatsAppMessageSchema = new mongoose.Schema({
  waId: String,
  from: String,
  to: String,
  text: String,
  type: String,
  direction: { type: String, enum: ["INBOUND", "OUTBOUND"] },
  status: String,
  timestamp: Date,
  raw: Object,
}, { timestamps: true });

module.exports = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);
