const mongoose = require("mongoose");

const sopSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    rewardType: {
      type: String,
      enum: ["cash", "coin"],
      required: true,
      default: "cash",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: String,
      default: "",
    },
    updatedBy: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

sopSchema.index({ name: 1 }, { unique: true });
sopSchema.index({ rewardType: 1, isActive: 1 });

module.exports = mongoose.models.SOP || mongoose.model("SOP", sopSchema);