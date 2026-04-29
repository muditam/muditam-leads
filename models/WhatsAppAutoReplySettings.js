const mongoose = require("mongoose");

const WhatsAppAutoReplySettingsSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: "default",
      unique: true,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    delayMinutes: {
      type: Number,
      default: 15,
      min: 1,
      max: 1440,
    },
    updatedBy: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

module.exports =
  mongoose.models.WhatsAppAutoReplySettings ||
  mongoose.model("WhatsAppAutoReplySettings", WhatsAppAutoReplySettingsSchema);
