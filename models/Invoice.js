const mongoose = require('mongoose');


const InvoiceSchema = new mongoose.Schema(
  {
    // May be null in dev if you don't have a valid ObjectId
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: false },
    uploadedBy: {
      id: { type: String },          // raw id from session/header
      name: { type: String },
      email: { type: String },
      role: { type: String },
    },
    companyName: { type: String, required: true, trim: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'clear'], default: 'pending' },
    fileUrl: { type: String, required: true },
    originalFilename: { type: String }
  },
  { timestamps: true }
);


InvoiceSchema.index({ 'uploadedBy.id': 1, createdAt: -1 });


module.exports = mongoose.model('Invoice', InvoiceSchema);

