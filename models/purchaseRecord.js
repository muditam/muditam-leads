const mongoose = require('mongoose');


const purchaseRecordSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: false,
    default: null
  },
  category: {
    type: String,
    required: false,
    default: ''
  },
  invoiceType: {
    type: String,
    required: false,
    default: ''
  },
  billingGst: {
    type: String,
    required: false,
    default: ''
  },
  invoiceNo: {
    type: String,
    required: false,
    default: ''
  },
  partyName: {
    type: String,
    trim: true,
    default: '',
  },
  invoiceAmount: {
    type: Number,
    required: false,
    default: 0
  },
  physicalInvoice: {
    type: String,
    enum: ['Yes', 'No', ''],
    default: 'No'
  },
  link: {
    type: String,
    default: ''
  },
  matchedWith2B: {
    type: String,
    enum: ['Yes', 'No', ''],
    default: 'No'
  },
  invoicingTally: {
    type: String,
    enum: ['Yes', 'No', ''],
    default: 'No'
  },
  vendorEmail: { type: String },
  vendorPhone: { type: String },
  paymentDate: {
    type: Date,
    default: null
  },
  // paymentScreenshot: {
  //   type: String,
  //   default: ''
  // },
  dueAtThisDate: {
    type: Number,
    default: 0,
    description: 'Snapshot of total due as of this record date (non-retroactive)'
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});


// Add a virtual field for serial number
purchaseRecordSchema.virtual('serialNumber').get(function() {
  return this._id;
});


// Ensure virtual fields are included when converting to JSON
purchaseRecordSchema.set('toJSON', { virtuals: true });
purchaseRecordSchema.set('toObject', { virtuals: true });

module.exports =
  mongoose.models.PurchaseRecord ||
  mongoose.model('PurchaseRecord', purchaseRecordSchema);

