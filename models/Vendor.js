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
      default: '',
      trim: true,
      uppercase: true, // ensures consistent casing for uniqueness
      // (length checks are handled in routes; keep schema flexible)
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

vendorSchema.index(
  { gstNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      gstNumber: { $ne: '' },
      isDeleted: { $ne: true },
    },
  }
);
 
module.exports = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
