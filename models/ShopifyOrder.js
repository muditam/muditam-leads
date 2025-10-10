// models/ShopifyOrder.js
const mongoose = require("mongoose");

function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
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
    phone: { type: String, set: normalizePhone },
    address1: String,
    address2: String,
    city: String,
    province: String,
    zip: String,
    country: String,
  },
  { _id: false }
);

const OrderConfirmOpsSchema = new mongoose.Schema(
  {
    callStatus: {
      type: String,
      enum: ["CNP", "ORDER_CONFIRMED", "CALL_BACK_LATER", "CANCEL_ORDER"],
      index: true,
    },
    callStatusUpdatedAt: { type: Date, default: null, index: true },

    shopifyNotes: { type: String, default: "" },

    doctorCallNeeded: { type: Boolean },
    dietPlanNeeded: { type: Boolean },
    assignedExpert: { type: String, default: "" }, 

    languageUsed: { type: String, default: "" },

    codToPrepaid: { type: Boolean }, 

    paymentLink: { type: String, default: "" },

    plusCount: { type: Number, default: 0 },
    plusUpdatedAt: { type: Date, default: null, index: true }, 
    ocCancelReason: { type: String, default: "" },

    assignedAgentId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true, default: null },
    assignedAgentName: { type: String, default: "" },
    assignedAt: { type: Date, default: null, index: true },
  },
  { _id: false }
);

const ShopifyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: Number, unique: true, index: true },
    orderName: { type: String, index: true },

    customerName: String,
    contactNumber: { type: String, set: normalizePhone },
    normalizedPhone: { type: String, index: true },

    orderDate: Date,
    amount: Number,
    paymentGatewayNames: [String],
    modeOfPayment: String,
    productsOrdered: [ProductSchema],

    channelName: String,
    customerAddress: AddressSchema,

    currency: String,
    financial_status: String,
    fulfillment_status: String,

    shopifyCreatedAt: Date,
    shopifyUpdatedAt: Date,

    cancelled_at: Date,
    cancel_reason: String,

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

ShopifyOrderSchema.index({ "orderConfirmOps.callStatus": 1, orderDate: -1 });
ShopifyOrderSchema.index({ "orderConfirmOps.callStatusUpdatedAt": -1 });
ShopifyOrderSchema.index({ "orderConfirmOps.assignedAgentId": 1, "orderConfirmOps.callStatus": 1 });
ShopifyOrderSchema.index({ "orderConfirmOps.assignedAt": -1 });

ShopifyOrderSchema.index(
  { "orderConfirmOps.shopifyNotes": "text" },
  {
    default_language: "none",
    language_override: "languageUsed",
  }
);

module.exports = mongoose.model("ShopifyOrder", ShopifyOrderSchema);
module.exports.normalizePhone = normalizePhone;

