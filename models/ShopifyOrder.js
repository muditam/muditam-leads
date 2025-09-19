// models/ShopifyOrder.js
const mongoose = require("mongoose");

// Normalize Indian numbers → keep ONLY last 10 digits
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d; // handles +91 / 91 / 0 prefixes
}

const ProductSchema = new mongoose.Schema(
  {
    title: String,
    quantity: Number,
    sku: String,
    variant_id: Number,
    price: Number,
    month: { type: String, default: "" },
    cohort: { type: String, default: "" },
  },
  { _id: false }
);

const AddressSchema = new mongoose.Schema(
  {
    name: String,
    phone: { type: String, set: normalizePhone }, // normalize on write
    address1: String,
    address2: String,
    city: String,
    province: String,
    zip: String,
    country: String,
  },
  { _id: false }
);

const ShopifyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: Number, unique: true, index: true },
    orderName: String,

    customerName: String,

    // Always store 10-digit number only
    contactNumber: { type: String, set: normalizePhone },
    normalizedPhone: { type: String, index: true }, // mirror for fast lookups

    orderDate: Date,
    amount: Number,                 // total_price
    paymentGatewayNames: [String],  // payment_gateway_names
    modeOfPayment: String,          // first gateway or joined
    productsOrdered: [ProductSchema],

    channelName: String,            // source_name
    customerAddress: AddressSchema,

    currency: String,
    financial_status: String,
    fulfillment_status: String,

    // watermarks for sync logic 
    shopifyCreatedAt: Date,
    shopifyUpdatedAt: Date,

    cancelled_at: Date,
    cancel_reason: String,
  },
  { timestamps: true }
);

// Keep normalized fields consistent on any write
ShopifyOrderSchema.pre("validate", function (next) {
  // contactNumber & normalizedPhone
  if (this.contactNumber) {
    const ten = normalizePhone(this.contactNumber);
    this.contactNumber = ten;
    this.normalizedPhone = ten;
  } else if (this.customerAddress?.phone) {
    const ten = normalizePhone(this.customerAddress.phone);
    this.normalizedPhone = ten;
  } else {
    this.normalizedPhone = "";
  }

  // ensure nested address phone also normalized
  if (this.customerAddress && this.customerAddress.phone) {
    this.customerAddress.phone = normalizePhone(this.customerAddress.phone);
  }
  next();
});

// Helpful indexes
ShopifyOrderSchema.index({ orderDate: -1, createdAt: -1 });
ShopifyOrderSchema.index({ "customerAddress.province": 1 });
ShopifyOrderSchema.index({ modeOfPayment: 1 });
ShopifyOrderSchema.index({ paymentGatewayNames: 1 });
ShopifyOrderSchema.index({ orderName: 1 });
ShopifyOrderSchema.index({ contactNumber: 1 });

module.exports = mongoose.model("ShopifyOrder", ShopifyOrderSchema);
// Optional: export normalizer for reuse in routes
module.exports.normalizePhone = normalizePhone;
