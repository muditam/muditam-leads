const mongoose = require("mongoose");

const customRewardRequestSchema = new mongoose.Schema(
  {
    agentName: {
      type: String,
      required: true,
      trim: true,
      index: true,
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

    url: {
      type: String,
      required: true,
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },

    requestedCoinBudget: {
      type: Number,
      default: 0,
      min: 0,
    },
    startDate: {
      type: String,
      default: "",
      index: true,
    },
    endDate: {
      type: String,
      default: "",
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

    extractedTitle: {
      type: String,
      default: "",
      trim: true,
    },
    extractedImage: {
      type: String,
      default: "",
      trim: true,
    },
    extractedDescription: {
      type: String,
      default: "",
      trim: true,
    },
    extractedSiteName: {
      type: String,
      default: "",
      trim: true,
    },

    metadataStatus: {
      type: String,
      enum: ["fetched", "failed", "partial"],
      default: "fetched",
      index: true,
    },
    metadataError: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    approvedRewardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reward",
      default: null,
    },

    reviewedBy: {
      type: String,
      default: "",
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },

    createdBy: {
      type: String,
      default: "",
    },
    createdByEmail: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

customRewardRequestSchema.index({ agentName: 1, status: 1, createdAt: -1 });
customRewardRequestSchema.index({ status: 1, createdAt: -1 });

module.exports =
  mongoose.models.CustomRewardRequest ||
  mongoose.model("CustomRewardRequest", customRewardRequestSchema);