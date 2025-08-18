// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,
    quantity: Number,
    price: Number, // minor units if available
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema(
  {
    // Idempotency keys
    eventId: { type: String, index: true, unique: true, sparse: true },
    checkoutId: { type: String, index: true },
    orderId: { type: String, index: true },

    type: { type: String, default: "abandoned_checkout", index: true },

    customer: {
      name: String,
      email: String,
      phone: String,
    },

    items: [ItemSchema],
    itemCount: Number,

    currency: { type: String, default: "INR" },
    total: Number, // store in paise if integer minor units; else raw number

    eventAt: { type: Date, default: Date.now }, // when it happened (provider time)
    receivedAt: { type: Date, default: Date.now }, // when we received

    // Notification state
    notified: { type: Boolean, default: false },
    notifiedAt: Date,
    notifyChannel: String, // "whatsapp" | "sms" | "email" | "manual"

    // Keep the raw for auditing / schema evolution
    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
