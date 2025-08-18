const mongoose = require("mongoose");

const FinanceOrderSchema = new mongoose.Schema(
  {
    shopifyId: { type: String, index: true, unique: true }, // Shopify numeric id as string
    createdAt: { type: Date, index: true }, // Date
    orderName: { type: String, index: true }, // "#1234"
    billingName: { type: String, default: "" },
    financialStatus: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    totalPrice: { type: Number, default: 0 }, // Price
    lmsNote: { type: String, default: "" },   // LMS Notes
  },
  { timestamps: true }
);

module.exports = mongoose.model("FinanceOrder", FinanceOrderSchema);
