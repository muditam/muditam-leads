// models/WhatsAppConversation.js
const mongoose = require("mongoose");

const WhatsAppConversationSchema = new mongoose.Schema(
  {
    phone: { type: String, index: true },

    // last message preview
    lastMessageAt: { type: Date, index: true },
    lastMessageText: { type: String, default: "" },

    // session window
    windowExpiresAt: Date,

    // ✅ NEW: unread + read tracking
    unreadCount: { type: Number, default: 0, index: true },
    lastReadAt: { type: Date, default: null },

    // (optional but helpful)
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WhatsAppConversationSchema.index({ phone: 1, lastMessageAt: -1 });

module.exports = mongoose.model("WhatsAppConversation", WhatsAppConversationSchema);
