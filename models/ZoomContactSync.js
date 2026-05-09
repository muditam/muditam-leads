const mongoose = require("mongoose");

const zoomContactSyncSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    zoomUserId: { type: String, default: "", index: true },
    lmsContactKey: { type: String, required: true, index: true }, // normalized E.164 phone
    zoomContactId: { type: String, default: "" },
    displayName: { type: String, default: "" },
    source: { type: String, default: "" },
    lastHash: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    retryCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "synced", "failed", "blocked_scope"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

zoomContactSyncSchema.index({ userId: 1, lmsContactKey: 1 }, { unique: true });
zoomContactSyncSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("ZoomContactSync", zoomContactSyncSchema);
