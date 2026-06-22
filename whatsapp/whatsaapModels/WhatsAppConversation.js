// models/WhatsAppConversation.js
const mongoose = require("mongoose");
 
const WhatsAppConversationSchema = new mongoose.Schema(
  {
    phone: { type: String, index: true },
    phone10: { type: String, default: "", index: true },
 
    // last message preview
    lastMessageAt: { type: Date, index: true },
    lastMessageText: { type: String, default: "" },
    displayName: { type: String, default: "" },
    displayNameNorm: { type: String, default: "", index: true },
    assignedToLabel: { type: String, default: "Unassigned" },
    assignedToLabelNorm: { type: String, default: "unassigned", index: true },
    manualAssignedToLabel: { type: String, default: "" },
    manualAssignedToLabelNorm: { type: String, default: "", index: true },
    manualAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    manualAssignedByName: { type: String, default: "" },
    manualAssignedAt: { type: Date, default: null },
    searchText: { type: String, default: "" },

    unknownOwnerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    unknownOwnerName: { type: String, default: "" },
    unknownOwnerNameNorm: { type: String, default: "", index: true },
    unknownVisibleToUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true }],
    unknownVisibleToNameNorms: [{ type: String, index: true }],
    unknownSource: { type: String, default: "" },
 
    // session window
    windowExpiresAt: Date,
 
    // ✅ NEW: unread + read tracking
    unreadCount: { type: Number, default: 0, index: true },
    lastReadAt: { type: Date, default: null },
 
    // (optional but helpful)
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    autoReplySentAt: { type: Date, default: null },
    autoReplyForInboundAt: { type: Date, default: null },
  },
  { timestamps: true }
);
 
WhatsAppConversationSchema.index({ phone: 1, lastMessageAt: -1 });
WhatsAppConversationSchema.index({ phone10: 1, lastMessageAt: -1 });
WhatsAppConversationSchema.index({ assignedToLabelNorm: 1, lastMessageAt: -1 });
WhatsAppConversationSchema.index({ unknownVisibleToUserIds: 1, lastMessageAt: -1 });
WhatsAppConversationSchema.index({ unknownVisibleToNameNorms: 1, lastMessageAt: -1 });
WhatsAppConversationSchema.index({ unreadCount: 1, lastMessageAt: -1 });
 
module.exports = mongoose.model("WhatsAppConversation", WhatsAppConversationSchema);
