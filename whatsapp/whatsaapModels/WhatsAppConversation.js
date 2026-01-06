const mongoose = require("mongoose");

const WhatsAppConversationSchema = new mongoose.Schema(
  {
    phone: { type: String, index: true },
    lastMessageAt: { type: Date, index: true },
    lastMessageText: { type: String, default: "" },  
    windowExpiresAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppConversation", WhatsAppConversationSchema);
