// models/PurchaseRecord.js
const mongoose = require('mongoose');

const purchaseRecordSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: false,
      default: null,
    },
    category: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    invoiceType: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    billingGst: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    invoiceNo: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    partyName: {
      type: String,
      trim: true,
      default: '',
    },
    invoiceAmount: {
      type: Number,
      required: false,
      default: 0,
      min: 0,
    },
    physicalInvoice: {
      type: String,
      enum: ['Yes', 'No', ''],
      default: 'No',
    },
    link: {
      type: String,
      default: '',
      trim: true,
    },
    matchedWith2B: {
      type: String,
      enum: ['Yes', 'No', ''],
      default: 'No',
    },
    invoicingTally: {
      type: String,
      enum: ['Yes', 'No', ''],
      default: 'No',
    },
    // paymentStatus: {
    //   type: String,
    //   enum: ['Pending', 'Paid', ''],
    //   default: 'Pending'
    // },
    // pendingPayment: {
    //   type: Number,
    //   default: 0
    // },
    vendorEmail: {
      type: String,
      trim: true,
      default: '',
    },
    vendorPhone: {
      type: String,
      trim: true,
      default: '',
    },
    paymentDate: {
      type: Date,
      default: null,
    },
    // paymentScreenshot: {
    //   type: String,
    //   default: ''
    // },
    dueAtThisDate: {
      type: Number,
      default: 0,
      description:
        'Snapshot of total due as of this record date (non-retroactive)',
      min: 0,
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

// Virtuals
purchaseRecordSchema.virtual('serialNumber').get(function () {
  return this._id;
});

// Ensure virtuals in outputs
purchaseRecordSchema.set('toJSON', { virtuals: true });
purchaseRecordSchema.set('toObject', { virtuals: true });

// Helpful indexes for prod querying
purchaseRecordSchema.index({ isDeleted: 1, createdAt: -1 });
purchaseRecordSchema.index({ date: -1 });
purchaseRecordSchema.index({ partyName: 1 });

// Guarded export to prevent model recompilation errors (Heroku/serverless)
module.exports =
  mongoose.models.PurchaseRecord ||
  mongoose.model('PurchaseRecord', purchaseRecordSchema);
