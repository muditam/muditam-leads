const mongoose = require("mongoose");

const walletCoinRedemptionSchema = new mongoose.Schema(
  {
    agentName: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
      index: true,
    },

    role: {
      type: String,
      default: "",
      trim: true,
    },

    startDate: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    endDate: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    rewardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reward",
      default: null,
      index: true,
    },

    customRewardRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomRewardRequest",
      default: null,
      index: true,
    },

    coinAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    approvedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    createdBy: {
      type: String,
      default: "",
      trim: true,
    },

    createdByEmail: {
      type: String,
      default: "",
      trim: true,
    },

    note: {
      type: String,
      default: "Wallet coin redeemed",
      trim: true,
    },
  },
  { timestamps: true }
);

walletCoinRedemptionSchema.index({
  agentName: 1,
  startDate: 1,
  endDate: 1,
  approvedAt: -1,
});

module.exports =
  mongoose.models.WalletCoinRedemption ||
  mongoose.model("WalletCoinRedemption", walletCoinRedemptionSchema);