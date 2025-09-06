const mongoose = require("mongoose");

const EmployeeSchema = new mongoose.Schema({
  fullName: { type: String, required: true }, 
  email: { type: String, required: true, unique: true },  
  callerId: { type: String, required: true },
  role: { type: String, required: true },
  password: { type: String, required: true }, 
  agentNumber: { type: String, required: true }, 
  async: { type: Number, default: 1 },
  status: { type: String, default: "active" }, 
  target: { type: Number, default: 0 },
  hasTeam: { type: Boolean, default: false },
  joiningDate: { type: Date, default: null },
  monthlyDeliveredSales: { type: mongoose.Schema.Types.Mixed, default: {} },
  totalDeliveredSales: { type: Number, default: 0 },
  teamMembers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: [] }], 
  teamLeader: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null }  
});

module.exports = mongoose.model("Employee", EmployeeSchema);
 
