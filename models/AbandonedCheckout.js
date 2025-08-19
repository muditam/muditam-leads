// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,          // product name/title
    variantTitle: String,   // e.g., "Large / Red"
    quantity: Number,
    unitPrice: Number,      // store in minor units (paise)
    finalLinePrice: Number, // line total after discounts (minor units)
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema(
  {
    // Primary idempotency keys (from GoKwik)
    requestId:  { type: String, index: true }, // request_id
    cId:        { type: String, index: true }, // c_id
    token:      { type: String, index: true }, // token

    // Back-compat/general ids
    eventId:    { type: String, index: true, unique: true, sparse: true },
    checkoutId: { type: String, index: true },
    orderId:    { type: String, index: true },

    isAbandoned: { type: Boolean, default: false },

    type: { type: String, default: "abandoned_cart", index: true },

    customer: {
      name:  String,
      email: String,
      phone: String,
    },

    items: [ItemSchema],
    itemCount: Number,

    currency: { type: String, default: "INR" },
    total: Number, // cart total in minor units (paise)

    abcUrl: String, // link back to cart (abc_url)

    eventAt:    { type: Date, default: Date.now }, // created_at from payload
    receivedAt: { type: Date, default: Date.now },

    notified: { type: Boolean, default: false },
    notifiedAt: Date,
    notifyChannel: String,

    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

// For range queries and fast scrolling
AbandonedCheckoutSchema.index({ eventAt: -1, _id: -1 });

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
