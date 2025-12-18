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
  issue: { type: String, default: "" },
  notificationFlags: {
  rtoNotified: { type: Boolean, default: false },
},
}, { timestamps: true }); 

OrderSchema.index(
  { shipment_status: 1, contact_number: 1, last_updated_at: -1 }, 
  { partialFilterExpression: { contact_number: { $exists: true, $ne: "" } } }
);

module.exports = mongoose.model('Order', OrderSchema); 