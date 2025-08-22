// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,          // product title/name ("Dress - X")
    variantTitle: String,   // if present
    quantity: Number,
    unitPrice: Number,      // minor units if possible (e.g., 47700)
    finalLinePrice: Number, // minor units (after discounts); fallback qty * unitPrice
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema(
  {
    // Idempotency keys
    eventId:    { type: String, index: true, unique: true, sparse: true }, // request_id
    checkoutId: { type: String, index: true },                              // token
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
    total: Number, // store in minor units (paise)

    // Extras useful for recovery & auditing
    recoveryUrl: String,  // abc_url
    ip: String,
    userAgent: String,
    city: String,

    eventAt:    { type: Date, default: Date.now }, // created_at from provider
    receivedAt: { type: Date, default: Date.now },

    notified: { type: Boolean, default: false },
    notifiedAt: Date,
    notifyChannel: String,

    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

// helpful for time range listing
AbandonedCheckoutSchema.index({ eventAt: -1, _id: -1 });

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
