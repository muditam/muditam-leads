const mongoose = require("mongoose");

const zoomPhoneSyncRunSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["incremental", "nightly", "manual"], default: "incremental", index: true },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date, default: null },
    status: { type: String, enum: ["running", "ok", "failed"], default: "running", index: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    pagesFetched: { type: Number, default: 0 },
    apiRows: { type: Number, default: 0 },
    upserts: { type: Number, default: 0 },
    updates: { type: Number, default: 0 },
    inserts: { type: Number, default: 0 },
    unresolvedAgentRows: { type: Number, default: 0 },
    syncErrors: { type: [String], default: [] },
    notes: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ZoomPhoneSyncRun", zoomPhoneSyncRunSchema);
