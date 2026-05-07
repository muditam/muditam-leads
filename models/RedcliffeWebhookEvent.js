const mongoose = require("mongoose");

const RedcliffeWebhookEventSchema = new mongoose.Schema(
  {
    hookType: { type: String, default: "" },
    source: { type: String, default: "redcliffe" },
    deliveryStatus: {
      type: String,
      enum: ["received", "processed", "rejected", "failed"],
      default: "received",
    },
    authVerified: { type: Boolean, default: false },
    requestHeaders: { type: mongoose.Schema.Types.Mixed, default: {} },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    processingError: { type: String, default: "" },
    meta: {
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "" },
      method: { type: String, default: "POST" },
      path: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

RedcliffeWebhookEventSchema.index({ createdAt: -1 });
RedcliffeWebhookEventSchema.index({ hookType: 1, createdAt: -1 });
RedcliffeWebhookEventSchema.index({ deliveryStatus: 1, createdAt: -1 });

module.exports =
  mongoose.models.RedcliffeWebhookEvent ||
  mongoose.model("RedcliffeWebhookEvent", RedcliffeWebhookEventSchema);
