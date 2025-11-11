// models/PaymentRecord.js
const mongoose = require('mongoose');

const paymentRecordSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      default: null,
    },
    vendorName: {
      type: String,
      default: '',
      trim: true,
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    amountDue: {
      type: Number,
      default: 0,
      min: 0,
      description: 'Calculated at creation time, never updated',
    },
    dueAtThisDate: {
      type: Number,
      default: 0,
      min: 0,
      description:
        'Snapshot of total due as of this record date (non-retroactive)',
    },
    screenshot: {
      type: String,
      default: '',
      trim: true,
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

// Helpful indexes for common queries
paymentRecordSchema.index({ isDeleted: 1, createdAt: -1 });
paymentRecordSchema.index({ date: -1 });
paymentRecordSchema.index({ vendorName: 1 });

// Guarded export to prevent recompilation errors on hot reload / serverless platforms
module.exports =
  mongoose.models.PaymentRecord ||
  mongoose.model('PaymentRecord', paymentRecordSchema);
