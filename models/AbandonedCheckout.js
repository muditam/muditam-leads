// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,          // product title/name
    variantTitle: String,   // if present
    quantity: Number,
    unitPrice: Number,      // store minor units (e.g., 47700 paise)
    finalLinePrice: Number, // minor units (after discounts); fallback qty * unitPrice
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema(
  {
    // Idempotency keys
    eventId:    { type: String, index: true, unique: true, sparse: true }, // e.g., request_id
    checkoutId: { type: String, index: true },                              // e.g., token
    orderId:    { type: String, index: true },

    type: { type: String, default: "abandoned_checkout", index: true },

    customer: {
      name:  String,
      email: String,
      phone: String,
    },

    items: [ItemSchema],
    itemCount: Number,

    currency: { type: String, default: "INR" },
    total: Number, // store minor units (paise)

    // Link shown in UI
    recoveryUrl: String,  // e.g., abc_url

    // Timestamps used for range filtering
    eventAt:    { type: Date, default: Date.now }, // created_at from provider
    receivedAt: { type: Date, default: Date.now },

    // Raw payload for debugging/audit
    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

// helpful for time range listing / sorting
AbandonedCheckoutSchema.index({ eventAt: -1, _id: -1 });

// light indexes to speed up common lookups/searches used by the UI
AbandonedCheckoutSchema.index({ "customer.phone": 1 });
AbandonedCheckoutSchema.index({ "items.title": 1 });

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
