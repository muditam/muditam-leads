const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema(
  {
    firstName: String,
    lastName: String,
    address1: String,
    address2: String,
    city: String,
    province: String,
    country: String,
    zip: String,
    phone: String,
  },
  { _id: false }
);

const CartItemSchema = new mongoose.Schema(
  {
    productId: String,
    variantId: String,
    title: String,
    variantTitle: String,
    sku: String,
    quantity: Number,
    price: Number,
  },
  { _id: false }
);

const FutureOrderSchema = new mongoose.Schema(
  {
    customerName: { type: String, default: "" },
    phoneNumber: { type: String, required: true, index: true },
    customerId: { type: String, default: "" },
    scheduledDate: { type: Date, required: true, index: true },
    paymentMode: { type: String, required: true },
    paymentStatus: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    partialPaidAmount: { type: Number, default: 0 },
    orderTotal: { type: Number, default: 0 },
    shippingCost: { type: Number, default: 0 },
    appliedDiscount: { type: Number, default: 0 },
    shippingAddress: AddressSchema,
    billingAddress: AddressSchema,
    cartItems: [CartItemSchema],
    shopifyOrderPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    orderDetails: {
      agentName: { type: String, default: "" },
      dosageOrdered: { type: String, default: "10-Days" },
      selfRemark: { type: String, default: "" },
      orderNote: { type: String, default: "" },
      upsellAmount: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      discountType: { type: String, default: "percentage" },
    },
    status: {
      type: String,
      enum: ["pending", "processing", "placed", "cancelled"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    lastAttemptAt: Date,
    placedAt: Date,
    shopifyOrderId: { type: String, default: "" },
    shopifyOrderName: { type: String, default: "" },
    myOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "MyOrder" },
    createdBy: { type: String, default: "" },
    createdByEmail: { type: String, default: "" },
  },
  { timestamps: true }
);

FutureOrderSchema.index({ status: 1, scheduledDate: 1, createdAt: -1 });

module.exports = mongoose.model("FutureOrder", FutureOrderSchema);
