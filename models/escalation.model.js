const mongoose = require('mongoose');

const EscalationSchema = new mongoose.Schema({
  date: String,           // (optional) consider Date in future
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
  reason: String,
  trackingId: { type: String, default: '' }, 
}, { timestamps: true });

// indexes to speed up list pages & filters
EscalationSchema.index({ status: 1, createdAt: -1 });
EscalationSchema.index({ assignedTo: 1, status: 1, createdAt: -1 });
EscalationSchema.index({ orderId: 1 });
EscalationSchema.index({ contactNumber: 1 });

module.exports = mongoose.model('Escalation', EscalationSchema);
