const mongoose = require("mongoose");

const RedcliffePaymentIntentSchema = new mongoose.Schema(
  {
    intentId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: [
        "payment_link_created",
        "paid",
        "redcliffe_booking_confirmed",
        "finalizing_shopify_order",
        "shopify_order_created",
        "failed",
      ],
      default: "payment_link_created",
      index: true,
    },
    bookingId: { type: String, default: "", index: true },
    bookingPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    bookingResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    shopifyOrderPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    razorpayPaymentLinkId: { type: String, default: "", index: true },
    razorpayPaymentLinkUrl: { type: String, default: "" },
    razorpayPaymentId: { type: String, default: "", index: true },
    razorpayPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    redcliffeConfirmResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    redcliffeConfirmedAt: { type: Date, default: null },
    shopifyDraftOrderId: { type: String, default: "" },
    shopifyOrderId: { type: String, default: "", index: true },
    shopifyOrderName: { type: String, default: "" },
    shopifyFinalPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

RedcliffePaymentIntentSchema.index({ status: 1, createdAt: -1 });

module.exports =
  mongoose.models.RedcliffePaymentIntent ||
  mongoose.model("RedcliffePaymentIntent", RedcliffePaymentIntentSchema);
