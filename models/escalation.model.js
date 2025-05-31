const mongoose = require('mongoose');

const EscalationSchema = new mongoose.Schema({
  date: String,
  orderId: String,
  name: String,
  contactNumber: String,
  agentName: String,
  query: String,
  attachedFileUrls: [String],  
  status: { type: String, default: 'Open' },
  assignedTo: String,
  remark: String,
  resolvedDate: String,
}, { timestamps: true });

module.exports = mongoose.model('Escalation', EscalationSchema); 
