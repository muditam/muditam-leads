const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema({
  name: { type: String, required: true }, 
  phone: { type: String, required: true },
  age: { type: Number, required: true },
  location: { type: String },
  lookingFor: { type: String, required: true },
  assignedTo: { type: String, required: true },
  followUpDate: { type: Date, required: true },  
  leadSource: { type: String, required: true },
  leadDate:     { type: Date, required: true },
  leadStatus: { type: String, default: "New Lead" },
  subLeadStatus: { type: String },
  createdAt: { type: Date, default: Date.now },
  dateAndTime: { type: Date, default: () => new Date() },  
}); 

module.exports = mongoose.model("Customer", CustomerSchema);
