// models/MyOrders.js

const mongoose = require('mongoose');

const MyOrderSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  phone: { type: String, required: true },
  shippingAddress: { type: String, required: true },
  paymentStatus: { type: String, required: true },
  productOrdered: { type: String, required: true }, 
  orderDate: { type: Date, required: true },
  orderId: { type: String, required: true },
  totalPrice: { type: Number, required: true }, 
  agentName: { type: String, required: true },
  partialPayment: { type: Number, required: true },
  dosageOrdered: { type: String, required: true },   
  selfRemark: { type: String },                      
  paymentMethod: { type: String, required: true },   
  upsellAmount: { type: Number, default: 0 }          
});

module.exports = mongoose.model('MyOrder', MyOrderSchema); 
