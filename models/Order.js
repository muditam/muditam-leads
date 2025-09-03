const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  order_id: { type: String, required: true, unique: true }, 
  shipment_status: { type: String, required: true },
  order_date: { type: Date },  
  contact_number: { type: String }, 
  tracking_number: { type: String },
  full_name: { type: String },
  carrier_title: { type: String },  
  selfUpdated: { type: Boolean, default: false }, 
  last_updated_at: { type: Date, default: Date.now },
  email_count: { type: Number, default: 0 },
  threadId: { type: String },  
}, { timestamps: true }); 

module.exports = mongoose.model('Order', OrderSchema); 