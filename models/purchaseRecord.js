const mongoose = require("mongoose");

const PurchaseRecordSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },

    category: { type: String, default: "" },
    invoiceType: { type: String, default: "" },
    billingGST: { type: String, default: "" },

    invoiceNo: { type: String, default: "" },

    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorName: { type: String, default: "" },

    amount: { type: Number, default: 0 },

    invoiceUrl: { type: String, default: "" },

    matched2B: { type: Boolean, default: false },
    tally: { type: Boolean, default: false },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PurchaseRecord", PurchaseRecordSchema);
