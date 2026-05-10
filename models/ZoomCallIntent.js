const mongoose = require("mongoose");

const zoomCallIntentSchema = new mongoose.Schema(
  {
    intentId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    leadId: { type: String, default: "", index: true },
    sourcePage: { type: String, default: "" },
    sourceContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    phoneRaw: { type: String, default: "" },
    phoneNumber: { type: String, default: "", index: true },
    dialNumberE164: { type: String, default: "" },
    status: {
      type: String,
      enum: ["initiated", "ringing", "connected", "ended", "failed", "missed", "rejected"],
      default: "initiated",
      index: true,
    },
    callId: { type: String, default: "", index: true },
    callHistoryUuid: { type: String, default: "", index: true },
    callElementId: { type: String, default: "", index: true },
    matchedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    lastEventType: { type: String, default: "" },
    lastEventAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

zoomCallIntentSchema.index({ userId: 1, phoneNumber: 1, createdAt: -1 });

module.exports = mongoose.model("ZoomCallIntent", zoomCallIntentSchema);
