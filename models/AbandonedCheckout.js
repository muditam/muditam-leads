// models/AbandonedCheckout.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: String,
    title: String,
    variantTitle: String,
    quantity: Number,
    unitPrice: Number,      // minor units
    finalLinePrice: Number, // minor units
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new mongoose.Schema( 
  {
    eventId:    { type: String, index: true, unique: true, sparse: true },
    checkoutId: { type: String, index: true },
    orderId:    { type: String, index: true },

    type: { type: String, default: "abandoned_checkout", index: true },

    customer: {
      name:  String,
      email: String,
      phone: String,
      state: String, // store state for display & assignment
    },

    // NEW: structured & text address for quick use
    customerAddress: {
      name: String,
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },
    customerAddressText: String,

    items: [ItemSchema],
    itemCount: Number,

    currency: { type: String, default: "INR" },
    total: Number, // minor units

    recoveryUrl: String,

    eventAt:    { type: Date, default: Date.now },
    receivedAt: { type: Date, default: Date.now },

    // PERSISTED assignment
    assignedExpert: {
      _id: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
      fullName: String,
      email: String,
      role: String,
    },
    assignedAt: Date,

    raw: mongoose.Schema.Types.Mixed, // keep raw for downstream parsing if needed
  },
  { timestamps: true }
);

// Queries & filters
AbandonedCheckoutSchema.index({ eventAt: -1, _id: -1 });
AbandonedCheckoutSchema.index({ "customer.phone": 1 });
AbandonedCheckoutSchema.index({ "items.title": 1 });
AbandonedCheckoutSchema.index({ "assignedExpert._id": 1 });

// Helps the webhook fallback upsert when eventId is absent
AbandonedCheckoutSchema.index({ checkoutId: 1, eventAt: 1 });

module.exports = mongoose.model("AbandonedCheckout", AbandonedCheckoutSchema);
