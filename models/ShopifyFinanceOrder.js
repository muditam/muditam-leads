const mongoose = require("mongoose");

const ShopifyFinanceOrderSchema = new mongoose.Schema(
  { 
    orderName: { type: String, required: true, index: true, unique: true }, 
    createdAt: { type: Date, required: true, index: true }, 
    billingName: { type: String, default: "" }, 
    phone: { type: String, default: "" },
    financialStatus: { type: String, default: "" },
    paymentMethod: { type: String, default: "" }, 
    totalPrice: { type: Number, default: 0 }, 
    lmsNote: { type: String, default: "" }, 
    shopifyId: { type: Number, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopifyFinanceOrder", ShopifyFinanceOrderSchema);
