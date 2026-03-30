const mongoose = require("mongoose");

const walletCashToCoinConversionSchema = new mongoose.Schema(
  {
    agentName: {
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
    role: {
      type: String,
      default: "",
    },

    startDate: {
      type: String,
      required: true,
      index: true,
    },
    endDate: {
      type: String,
      required: true,
      index: true,
    },

    cashAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    coinAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    conversionRate: {
      type: Number,
      required: true,
      default: 1,
    },

    convertedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    createdBy: {
      type: String,
      default: "",
    },
    createdByEmail: {
      type: String,
      default: "",
    },

    note: {
      type: String,
      default: "Cash converted into coin",
    },
  },
  { timestamps: true }
);

walletCashToCoinConversionSchema.index({
  agentName: 1,
  startDate: 1,
  endDate: 1,
  convertedAt: -1,
});

module.exports =
  mongoose.models.WalletCashToCoinConversion ||
  mongoose.model(
    "WalletCashToCoinConversion",
    walletCashToCoinConversionSchema
  );