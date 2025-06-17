const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  order_id: { type: String, required: true, unique: true },
  shipment_status: { type: String, required: true },
  order_date: { type: Date },  
  contact_number: { type: String }, 
}, { timestamps: true }); 

module.exports = mongoose.model('Order', OrderSchema); 
 