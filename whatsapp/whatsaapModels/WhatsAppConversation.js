const mongoose = require("mongoose");

const WhatsAppConversationSchema = new mongoose.Schema({
  phone: String,
  lastMessageAt: Date,
  windowExpiresAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("WhatsAppConversation", WhatsAppConversationSchema);
