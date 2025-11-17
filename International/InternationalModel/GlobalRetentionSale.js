// InternationalModel/GlobalRetentionSale.js
const mongoose = require("mongoose");

const GlobalRetentionSaleSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },

    name: { type: String, trim: true },

    contactNumber: { type: String, trim: true },

    productsOrdered: { type: String, trim: true },

    dosageOrdered: { type: String, trim: true },

    amountPaid: { type: Number },

    orderId: { type: String, trim: true },

    orderCreatedBy: { type: String, trim: true },

    remarks: { type: String, trim: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "GlobalRetentionSale",
  GlobalRetentionSaleSchema
);
