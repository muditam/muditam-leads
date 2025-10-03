// models/ScheduleCall.js
const mongoose = require("mongoose");

const ScheduleCallSchema = new mongoose.Schema(
  {
    // Optional linkage to your internal objects (order / customer / lead etc.)
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: false },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: false },

    // From frontend
    doctorCallNeeded: { type: Boolean, default: true },
    assignedExpert: {
      // can be agent id (string) or ref — keep string to stay flexible with your existing "agents" array
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    scheduleCallAt: { type: Date, required: true, index: true }, // stored in UTC
    scheduleDurationMin: { type: Number, required: true, min: 5, max: 180 },

    scheduleCallNotes: { type: String, default: "" },

    status: {
      type: String,
      enum: ["SCHEDULED", "COMPLETED", "CANCELED", "NO_SHOW", "RESCHEDULED"],
      default: "SCHEDULED",
      index: true,
    },
    // If a schedule is a reschedule of another
    parentScheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "ScheduleCall" },
    // Audit
    createdBy: { type: String }, // agent/user id if you want
    updatedBy: { type: String }, 
  },
  { timestamps: true }
);

// Prevent double booking: unique per expert per exact minute start
ScheduleCallSchema.index(
  { assignedExpert: 1, scheduleCallAt: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["SCHEDULED", "RESCHEDULED"] } } }
);

module.exports = mongoose.model("ScheduleCall", ScheduleCallSchema);
