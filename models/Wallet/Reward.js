const mongoose = require("mongoose");

function getMilestoneByCoinCost(coinCost) {
  const value = Number(coinCost || 0);

  if (value >= 48000) return { id: 8, label: "Milestone 8" };
  if (value >= 42000) return { id: 7, label: "Milestone 7" };
  if (value >= 36000) return { id: 6, label: "Milestone 6" };
  if (value >= 30000) return { id: 5, label: "Milestone 5" };
  if (value >= 24000) return { id: 4, label: "Milestone 4" };
  if (value >= 18000) return { id: 3, label: "Milestone 3" };
  if (value >= 12000) return { id: 2, label: "Milestone 2" };
  if (value >= 6000) return { id: 1, label: "Milestone 1" };

  return { id: null, label: "Below Milestone 1" };
}

const rewardSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    image: {
      type: String,
      default: "",
      trim: true,
    },

    coinCost: {
      type: Number,
      required: true,
      min: 1,
      index: true,
    },

    price: {
      type: Number,
      default: 0,
      min: 0,
    },

    link: {
      type: String,
      required: true,
      trim: true,
    },

    brand: {
      type: String,
      default: "",
      trim: true,
    },

    category: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    milestoneId: {
      type: Number,
      default: null,
      index: true,
    },

    milestoneLabel: {
      type: String,
      default: "",
      trim: true,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },

    sourceType: {
      type: String,
      enum: ["curated", "approved_custom"],
      default: "curated",
      index: true,
    },

    customRewardRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomRewardRequest",
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    createdBy: {
      type: String,
      default: "",
      trim: true,
    },

    updatedBy: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

rewardSchema.pre("validate", function (next) {
  const milestone = getMilestoneByCoinCost(this.coinCost);
  this.milestoneId = milestone.id;
  this.milestoneLabel = milestone.label;
  next();
});

rewardSchema.index({ isActive: 1, milestoneId: 1, coinCost: 1 });
rewardSchema.index({
  title: "text",
  brand: "text",
  category: "text",
  note: "text",
  milestoneLabel: "text",
});

module.exports =
  mongoose.models.Reward || mongoose.model("Reward", rewardSchema);