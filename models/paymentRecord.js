 const mongoose = require('mongoose');


const paymentRecordSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: null
  },
  vendorName: {
    type: String,
    default: ''
  },
  amountPaid: {
    type: Number,
    default: 0
  },
  amountDue: {
    type: Number,
    default: 0,
    description: 'Calculated at creation time, never updated'
  },
  dueAtThisDate: {
    type: Number,
    default: 0,
    description: 'Snapshot of total due as of this record date (non-retroactive)'
  },
  screenshot: {
    type: String,
    default: ''
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


const PaymentRecord = mongoose.model('PaymentRecord', paymentRecordSchema);


module.exports = PaymentRecord;

