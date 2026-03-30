const mongoose = require("mongoose");

const vkrOrderRowSchema = new mongoose.Schema(
  {
    date: { type: String, default: "" },
    orderId: { type: String, default: "" },
    customerName: { type: String, default: "" },
    contactNumber: { type: String, default: "" },
    shipmentStatus: { type: String, default: "" },
    vkrCount: { type: Number, default: 0 },
    isDelivered: { type: Boolean, default: false },
    coinsIfDelivered: { type: Number, default: 0 },
  },
  { _id: false }
);

const vkrWalletMonthlySnapshotSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      required: true,
      index: true,
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
      index: true,
    },
    agentName: {
      type: String,
      required: true,
      index: true,
    },
    role: {
      type: String,
      default: "",
    },

    sopName: {
      type: String,
      default: "VKR Plan Wallet Coin",
    },
    sopValuePerCount: {
      type: Number,
      default: 0,
    },

    startDate: {
      type: String,
      required: true,
    },
    endDate: {
      type: String,
      required: true,
    },
    effectiveStartDate: {
      type: String,
      default: "",
    },
    joiningDate: {
      type: String,
      default: "",
    },

    dailyTarget: {
      type: Number,
      default: 2,
    },
    workingDays: {
      type: Number,
      default: 0,
    },
    monthlyTargetCount: {
      type: Number,
      default: 0,
    },
    deliveredCount: {
      type: Number,
      default: 0,
    },
    achievementPercent: {
      type: Number,
      default: 0,
    },
    minAchievementPercentToRetain: {
      type: Number,
      default: 60,
    },
    status: {
      type: String,
      enum: ["earned", "lapsed"],
      default: "earned",
      index: true,
    },

    qualifyingOrders: {
      type: Number,
      default: 0,
    },
    deliveredQualifyingOrders: {
      type: Number,
      default: 0,
    },
    projectedCoins: {
      type: Number,
      default: 0,
    },
    earnedCoins: {
      type: Number,
      default: 0,
    },
    lapsedCoins: {
      type: Number,
      default: 0,
    },

    rows: {
      type: [vkrOrderRowSchema],
      default: [],
    },

    isLocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    lockedBy: {
      type: String,
      default: "",
    },

    computedAt: {
      type: Date,
      default: Date.now,
    },
    computedBy: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

vkrWalletMonthlySnapshotSchema.index(
  { monthKey: 1, agentName: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.VKRWalletMonthlySnapshot ||
  mongoose.model("VKRWalletMonthlySnapshot", vkrWalletMonthlySnapshotSchema);