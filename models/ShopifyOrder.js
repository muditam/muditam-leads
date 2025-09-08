const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  { title: String, quantity: Number, sku: String, variant_id: Number, price: Number },
  { _id: false }
);

const AddressSchema = new mongoose.Schema(
  {
    name: String,
    phone: String,
    address1: String,
    address2: String,
    city: String,
    province: String,
    zip: String,
    country: String,
  },
  { _id: false }
);
 
// Normalize Indian numbers → last 10 digits
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

const ShopifyOrderSchema = new mongoose.Schema(
  {
    orderId: { type: Number, unique: true, index: true }, // Shopify numeric id
    orderName: String,                                    // e.g. "#1001"

    customerName: String,
    contactNumber: String,
    normalizedPhone: { type: String, index: true },

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
  },
  { timestamps: true }
);

ShopifyOrderSchema.pre("save", function (next) {
  if (this.contactNumber && !this.normalizedPhone) {
    this.normalizedPhone = normalizePhone(this.contactNumber);
  }
  next();
});

module.exports = mongoose.model("ShopifyOrder", ShopifyOrderSchema);
