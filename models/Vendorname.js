// models/Vendorname.js
const mongoose = require("mongoose");

const VendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },

    hasGST: { type: Boolean, default: false },
 
    gstNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true }
);
 
VendorSchema.index(
  { gstNumber: 1 },
  { unique: true, partialFilterExpression: { gstNumber: { $type: "string", $ne: "" } } }
);

module.exports = mongoose.model("Vendor", VendorSchema);
