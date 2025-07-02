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
  teamMembers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: [] }]
});

module.exports = mongoose.model("Employee", EmployeeSchema);
 