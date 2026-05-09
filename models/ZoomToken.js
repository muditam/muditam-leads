const mongoose = require("mongoose");

const zoomTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, unique: true, index: true },
    zoomUserId: { type: String, default: "" },
    zoomEmail: { type: String, default: "" },
    accessTokenEnc: { type: String, required: true },
    refreshTokenEnc: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    scopes: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ZoomToken", zoomTokenSchema);
