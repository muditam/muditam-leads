// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,          // product name/title
    variantTitle: String,   // e.g., "Large / Red"
    quantity: Number,
    unitPrice: Number,      // prefer minor units if provider sends minor units
    finalLinePrice: Number, // after discounts; fallback qty * unitPrice
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema(
  {
    eventId:   { type: String, index: true, unique: true, sparse: true },
    checkoutId:{ type: String, index: true },
    orderId:   { type: String, index: true },

    type: { type: String, default: "abandoned_checkout", index: true },

    customer: {
      name:  String,
      email: String,
      phone: String,
    },

    items: [ItemSchema],
    itemCount: Number,

    currency: { type: String, default: "INR" },
    total: Number,          // prefer minor units if upstream sends them

    eventAt:   { type: Date, default: Date.now },
    receivedAt:{ type: Date, default: Date.now },

    notified:    { type: Boolean, default: false },
    notifiedAt:  Date,
    notifyChannel: String,

    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

// Helpful for time range queries
AbandonedCheckoutSchema.index({ eventAt: -1, _id: -1 });

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
