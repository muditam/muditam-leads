const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
  date: String,
  time: String,
  name: String,
  contactNumber: String, 
  leadSource: String,
  enquiryFor: String, 
  customerType: String,
  agentAssigned: String,
  productPitched: [String],
  leadStatus: String, 
  salesStatus: String,
  nextFollowup: String,
  calculateReminder: String,
  agentsRemarks: String,
  productsOrdered: [String],
  dosageOrdered: String,
  amountPaid: Number,
  modeOfPayment: String,
  deliveryStatus: String,
  healthExpertAssigned: String,
  orderId: String,
  dosageExpiring: String,
  rtNextFollowupDate: String,
  rtFollowupReminder: String,
  rtFollowupStatus: String,
  lastOrderDate: String,
  repeatDosageOrdered: String,
  retentionStatus: String,
  rtRemark: String,
});
 
const Lead = mongoose.model('Lead', LeadSchema);

module.exports = Lead;
