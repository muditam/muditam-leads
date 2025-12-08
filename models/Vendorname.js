//models/Vendorname.js
const mongoose = require("mongoose");

const VendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },

    hasGST: { type: Boolean, default: false },
    gstNumber: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Vendor", VendorSchema);
