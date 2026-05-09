const mongoose = require("mongoose");

const zoomCallLogSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    zoomUserId: { type: String, index: true },
    direction: { type: String, enum: ["inbound", "outbound", "unknown"], default: "unknown" },
    phoneNumber: { type: String, default: "" },
    callerNumber: { type: String, default: "" },
    calleeNumber: { type: String, default: "" },
    status: { type: String, default: "created" },
    startTime: Date,
    endTime: Date,
    duration: { type: Number, default: 0 },

    recordingId: { type: String, default: "" },
    recordingStatus: { type: String, enum: ["none", "pending", "downloading", "completed", "failed"], default: "none" },
    recordingUrl: { type: String, default: "" },

    transcriptId: { type: String, default: "" },
    transcriptStatus: { type: String, enum: ["none", "pending", "completed", "failed"], default: "none" },
    transcriptContent: { type: String, default: "" },

    notes: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

zoomCallLogSchema.index({ agentId: 1, startTime: -1 });
zoomCallLogSchema.index({ phoneNumber: 1, startTime: -1 });
zoomCallLogSchema.index({ transcriptContent: "text" });

module.exports = mongoose.model("ZoomCallLog", zoomCallLogSchema);
