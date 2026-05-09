const mongoose = require("mongoose");

const zoomWebhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    callId: { type: String, default: "", index: true },
    receivedAt: { type: Date, default: Date.now },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    processed: { type: Boolean, default: false },
    processingError: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ZoomWebhookEvent", zoomWebhookEventSchema);
