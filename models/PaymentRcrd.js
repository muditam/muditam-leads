const mongoose = require("mongoose");

const PaymentRcrdSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },

    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorName: { type: String, default: "" },

    amountPaid: { type: Number, required: true },

    due: { type: Number, default: 0 }, // snapshot due for that date

    screenshotUrl: { type: String, default: "" },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.PaymentRcrd ||
  mongoose.model("PaymentRcrd", PaymentRcrdSchema);
