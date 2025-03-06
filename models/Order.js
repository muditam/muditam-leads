const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  shipment_status: { type: String, required: true },
  order_date: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Order', OrderSchema);
