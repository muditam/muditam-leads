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

// === Order Confirmation / Ops subdocument ===
const OrderConfirmOpsSchema = new mongoose.Schema(
  {
    // Dropdown (labeled "Shopify Notes" in UI but stores call status enum)
    callStatus: {
      type: String,
      enum: ["CNP", "ORDER_CONFIRMED", "CALL_BACK_LATER", "CANCEL_ORDER"], 
      index: true,
    },
    callStatusUpdatedAt: { type: Date, default: null, index: true },

    // Real Shopify notes we also push to Shopify order.note
    shopifyNotes: { type: String, default: "" },

    // Toggles & related fields
    doctorCallNeeded: { type: Boolean, default: false },
    dietPlanNeeded: { type: Boolean, default: false },
    assignedExpert: { type: String, default: "" },

    languageUsed: { type: String, default: "" },  

    codToPrepaid: { type: Boolean, default: false },
    paymentLink: { type: String, default: "" },
  },
  { _id: false }
);

const ShopifyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: Number, unique: true, index: true },  // Shopify numeric order ID
    orderName: { type: String, index: true },               // e.g. "#1001"

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
 
    shopifyCreatedAt: Date,
    shopifyUpdatedAt: Date,

    cancelled_at: Date,
    cancel_reason: String,

    // === Ops subdoc ===
    orderConfirmOps: { type: OrderConfirmOpsSchema, default: () => ({}) },
  },
  { timestamps: true }
);
 
ShopifyOrderSchema.pre("validate", function (next) { 
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
 
  if (this.customerAddress && this.customerAddress.phone) {
    this.customerAddress.phone = normalizePhone(this.customerAddress.phone);
  }
  next();
});
 
ShopifyOrderSchema.index({ orderDate: -1, createdAt: -1 });
ShopifyOrderSchema.index({ "customerAddress.province": 1 });
ShopifyOrderSchema.index({ modeOfPayment: 1 });
ShopifyOrderSchema.index({ paymentGatewayNames: 1 });
ShopifyOrderSchema.index({ orderName: 1 });
ShopifyOrderSchema.index({ contactNumber: 1 });

// Ops indexes
ShopifyOrderSchema.index({ "orderConfirmOps.callStatus": 1, orderDate: -1 });
ShopifyOrderSchema.index({ "orderConfirmOps.callStatusUpdatedAt": -1 }); 
ShopifyOrderSchema.index(
  { "orderConfirmOps.shopifyNotes": "text" },
  {
    default_language: "none",
    language_override: "languageUsed", 
  }
);



module.exports = mongoose.model("ShopifyOrder", ShopifyOrderSchema); 

module.exports.normalizePhone = normalizePhone;
