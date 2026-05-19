const mongoose = require("mongoose");

const zoomCallLogSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    callHistoryUuid: { type: String, default: "", index: true },
    callElementId: { type: String, default: "", index: true },
    callElementIds: { type: [String], default: [] },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    zoomUserId: { type: String, index: true },
    direction: { type: String, enum: ["inbound", "outbound", "unknown"], default: "unknown" },
    outcome: { type: String, default: "unknown", index: true },
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
    recordingAttempts: { type: Number, default: 0 },
    recordingNextAttemptAt: { type: Date, default: null, index: true },
    recordingLeaseUntil: { type: Date, default: null, index: true },

    transcriptId: { type: String, default: "" },
    transcriptStatus: { type: String, enum: ["none", "pending", "completed", "failed"], default: "none" },
    transcriptContent: { type: String, default: "" },

    sourcePage: { type: String, default: "" },
    leadId: { type: String, default: "", index: true },
    intentId: { type: String, default: "", index: true },
    dialInitiatedAt: { type: Date, default: null },
    eventType: { type: String, default: "" },

    notes: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

zoomCallLogSchema.index({ agentId: 1, startTime: -1 });
zoomCallLogSchema.index({ phoneNumber: 1, startTime: -1 });
zoomCallLogSchema.index({ transcriptContent: "text" });

module.exports = mongoose.model("ZoomCallLog", zoomCallLogSchema);
