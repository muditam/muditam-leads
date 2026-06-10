const mongoose = require('mongoose');

const UrgentDeliverySchema = new mongoose.Schema({
  date: { type: String, required: true },
  name: { type: String, trim: true, default: '' },
  contactNumber: { type: String, trim: true, default: '' },
  orderId: { type: String, trim: true, required: true },
  expertName: { type: String, trim: true, default: '' },
  remark: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['Pending', 'Delivered'], default: 'Pending' },
  deliveredAt: { type: Date },
}, { timestamps: true });

UrgentDeliverySchema.index({ status: 1, createdAt: -1 });
UrgentDeliverySchema.index({ orderId: 1 });
UrgentDeliverySchema.index(
  { deliveredAt: 1 },
  { expireAfterSeconds: 15 * 24 * 60 * 60 }
);

module.exports = mongoose.model('UrgentDelivery', UrgentDeliverySchema);
