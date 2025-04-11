const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  age: { type: Number, required: true },
  location: { type: String, required: true },
  lookingFor: { type: String, required: true },
  assignedTo: { type: String, required: true },
  followUpDate: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  dateAndTime: { type: Date, default: () => new Date() },
});

module.exports = mongoose.model("Customer", CustomerSchema);
