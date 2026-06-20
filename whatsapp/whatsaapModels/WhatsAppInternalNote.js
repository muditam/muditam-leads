const mongoose = require("mongoose");

const WhatsAppInternalNoteSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    phone10: { type: String, required: true, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    text: { type: String, required: true, trim: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

WhatsAppInternalNoteSchema.index({ phone10: 1, createdAt: -1 });

module.exports =
  mongoose.models.WhatsAppInternalNote ||
  mongoose.model("WhatsAppInternalNote", WhatsAppInternalNoteSchema);
