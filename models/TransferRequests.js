// models/TransferRequest.js
const mongoose = require('mongoose');

const TransferRequestSchema = new mongoose.Schema({
  leadId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Lead', 
    required: true 
  },
  requestedBy: { 
    type: String, 
    required: true  
  },
  role: { 
    type: String, 
    enum: ['Sales Agent', 'Retention Agent'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('TransferRequest', TransferRequestSchema);
 