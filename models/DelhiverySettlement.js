const mongoose = require("mongoose");

const delhiverySchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },
 
  awbNo: String, 
  utrNo: String,      
  amount: Number,     
  settledDate: String,  
  orderId: String,   
});

module.exports = mongoose.model("DelhiverySettlement", delhiverySchema);
