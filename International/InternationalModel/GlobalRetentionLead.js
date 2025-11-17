// InternationalModel/GlobalRetentionLead.js
const mongoose = require("mongoose");

// Nested schema for full retention details (typed, no Mixed)
const GlobalRetentionDetailsSchema = new mongoose.Schema(
  {
    age: { type: Number },
    height: { type: Number }, // cm
    weight: { type: Number },

    // Diabetes
    hba1c: { type: Number },
    fastingSugar: { type: Number },
    ppSugar: { type: Number },
    durationOfDiabetes: { type: String, trim: true },
    lastTestDone: { type: String, trim: true },

    // Cholesterol
    totalCholesterol: { type: Number },
    ldl: { type: Number },
    hdl: { type: Number },
    triglycerides: { type: Number },
    lastCholesterolTest: { type: String, trim: true },

    // Fatty Liver
    sgpt: { type: Number },
    sgot: { type: Number },
    ggt: { type: Number },
    ultrasoundFindings: { type: String, trim: true },
    lastLiverTest: { type: String, trim: true },

    // Lifestyle
    gender: { type: String, trim: true },
    dietType: { type: String, trim: true },
    sittingTime: { type: String, trim: true },
    exerciseRoutine: { type: String, trim: true },
    outsideMeals: { type: String, trim: true },
    timeOfSleep: { type: String, trim: true },
    energyLevels: { type: String, trim: true },
    sleepQuality: { type: String, trim: true },
    gutIssues: { type: String, trim: true },

    // Medications & Effects + Symptoms
    currentMedications: [{ type: String, trim: true }],
    sideEffects: { type: String, trim: true },
    suddenSugarFluctuations: { type: String, trim: true },
    familyHistory: { type: String, trim: true },
    monitorBloodSugar: { type: String, trim: true },
    sugarCravings: { type: String, trim: true },
    stressLevel: { type: String, trim: true },
    symptoms: [{ type: String, trim: true }],
  },
  { _id: false }
);

const GlobalRetentionLeadSchema = new mongoose.Schema(
  {
    // Basic details
    name: { type: String, trim: true },
    fullName: { type: String, trim: true }, // optional legacy
    phoneNumber: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },
    contactNumber: { type: String, trim: true },

    age: { type: Number }, // quick filter usage

    // Condition / problem
    lookingFor: { type: String, trim: true }, // what you send from frontend
    condition: { type: String, trim: true }, // usually mirrors lookingFor

    // Retention & follow-up
    retentionStatus: { type: String, trim: true }, // "Active" / "Lost" etc.
    status: { type: String, trim: true }, // optional legacy status

    followupStatus: { type: String, trim: true }, // "Good result", "No result", etc.
    prefMethod: { type: String, trim: true }, // "Call", "WhatsApp", "Both"
    communicationMethod: { type: String, trim: true }, // legacy if any

    nextFollowup: { type: Date }, // used to compute Today/Tomorrow/Later/Missed
    followupTag: { type: String, trim: true }, // optional manual label override

    // For list view "Last Order" & "Last Reached"
    lastOrderAt: { type: Date },
    lastReachedAt: { type: Date },

    // 🔹 Full typed retention details (matches your GlobalRetentiondetails object)
    globalRetentionDetails: {
      type: GlobalRetentionDetailsSchema,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "GlobalRetentionLead",
  GlobalRetentionLeadSchema
);
