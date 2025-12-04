// models/Vendor.js
const mongoose = require('mongoose');


const phoneRegex = /^\d{10}$/;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const vendorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phoneNumber: {
      type: String,
      default: '',
      trim: true,
      validate: {
        validator: (v) => v === '' || phoneRegex.test(v),
        message: 'Phone number must be exactly 10 digits',
      },
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      validate: {
        validator: (v) => v === '' || emailRegex.test(v),
        message: 'Invalid email address',
      },
    },
    hasGST: {
      type: Boolean,
      default: false,
    },
  gstNumber: {
  type: String,
  default: "",
  trim: true,
  uppercase: true,
  validate: {
    validator: (v) =>
      v === "" || /^[A-Z0-9]{15}$/.test(v),
    message: "GST number must be 15 characters (A-Z, 0-9)",
  },
},


    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);


// Indexes
vendorSchema.index({ name: 1 });
vendorSchema.index({ isDeleted: 1 });


// ✅ Unique GST index for non-empty GST numbers
vendorSchema.index(
  { gstNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { gstNumber: { $ne: '' } },
  }
);


module.exports = mongoose.model('Vendor', vendorSchema);



