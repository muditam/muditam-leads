// models/DietPlan.js
const mongoose = require("mongoose");

const MonthlySlotSchema = new mongoose.Schema(
  {
    time: { type: String, default: "" },
    options: { type: [String], default: [] },
  },
  { _id: false }
);

const DietPlanSchema = new mongoose.Schema(
  {
    customer: {
      leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
      name: { type: String, required: true, index: true },
      phone: { type: String, default: "" },
    },

    planType: { type: String, enum: ["Weekly", "Monthly"], required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "DietTemplate" },
    templateLabel: { type: String, default: "" },
    templateType: { type: String, enum: ["weekly-14", "monthly-options"], required: true },

    startDate: { type: Date, required: true, index: true },
    durationDays: { type: Number, required: true },

    // Weekly (14) body 
    fortnight: { 
      Breakfast: { type: [String], default: undefined },
      Lunch:     { type: [String], default: undefined },
      Snacks:    { type: [String], default: undefined },
      Dinner:    { type: [String], default: undefined },
    },

    // Weekly meal times (editable in UI)
    weeklyTimes: {
      Breakfast: { type: String, default: "" },
      Lunch:     { type: String, default: "" },
      Snacks:    { type: String, default: "" },
      Dinner:    { type: String, default: "" },
    }, 

    // Monthly (options) body
    monthly: {
      Breakfast:      { type: MonthlySlotSchema, default: undefined },
      Lunch:          { type: MonthlySlotSchema, default: undefined },
      "Evening Snack":{ type: MonthlySlotSchema, default: undefined },
      Dinner:         { type: MonthlySlotSchema, default: undefined },
    },
  
    createdBy: { type: String, default: "system" },
    version: { type: Number, default: 1 },
    notes: { type: String, default: "" },
  },
  { timestamps: true, minimize: false }
);

DietPlanSchema.index({ "customer.leadId": 1, startDate: -1 });
DietPlanSchema.index({ "customer.name": 1, startDate: -1 });

module.exports = mongoose.model("DietPlan", DietPlanSchema);
