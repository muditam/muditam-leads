const mongoose = require("mongoose");


const ToolAccessRequestSchema = new mongoose.Schema(
  {
    toolName: { type: String, required: true },
    reason: { type: String, default: "" },


    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },


    requestedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },


    requestedDate: { type: Date, required: true },


    status: {
      type: String,
      enum: ["Pending", "Completed", "Rejected"],
      default: "Pending",
    },


    shareType: {
      type: String,
      enum: ["password", "access", null],
      default: null,
    },


    shareChannel: {
      type: String,
      enum: ["teams", "whatsapp", "email", "phone", null],
      default: null,
    },


    rejectionReason: { type: String, default: "" },


    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },


    sharedAt: { type: Date },
  },
  { timestamps: true }
);


module.exports = mongoose.model("ToolAccessRequest", ToolAccessRequestSchema);



