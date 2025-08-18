const mongoose = require("mongoose");

const bluedartSettlementSchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },
  awbNo: String,           
  dpuDate: String,        
  processDate: String,      
  orderId: String,         
  portalName: String,     
  customerPayAmt: Number,  
  utr: String,            
  settledDate: String,    
});

module.exports = mongoose.model("BluedartSettlement", bluedartSettlementSchema);
