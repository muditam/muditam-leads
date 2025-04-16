const mongoose = require("mongoose");

const ConsultationDetailsSchema = new mongoose.Schema(
  {
    // Reference to the Customer document (assumed unique per customer)
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

    // Data coming from Presales.js
    presales: {
      leadStatus: { type: String, default: "New Lead" }, // New field for Lead Status
      hba1c: { type: String },
      lastTestDone: { type: String },
      fastingSugar: { type: String },
      ppSugar: { type: String },
      durationOfDiabetes: { type: String },
      gender: { type: String },
      dietType: { type: String },
      weight: { type: Number },
      sittingTime: { type: String },
      exerciseRoutine: { type: String }, 
      outsideMeals: { type: String },
      timeOfSleep: { type: String },
      notes: { type: String },
      assignExpert: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" }, 
      file: { type: String }, // Stores file path or URL
      // Call checklist from Presales.js
      checklist: {
        confirmedCustomerIdentity: { type: Boolean, default: false },
        confirmedLeadInquiry: { type: Boolean, default: false },
        introducedSelfAndCompany: { type: Boolean, default: false },
        explainedConsultationProcess: { type: Boolean, default: false },
        mentionedFreeDoctorConsultation: { type: Boolean, default: false },
        explainedAllRoundApproach: { type: Boolean, default: false },
        discussedLifestyleChanges: { type: Boolean, default: false },
        mentionedPriceRange: { type: Boolean, default: false },
        gotCustomerAgreement: { type: Boolean, default: false },
        callTransferPitch: { type: Boolean, default: false },
        introduceDoctor: { type: Boolean, default: false },
      },
    },

    // Data coming from Consultation.js
    consultation: {
      currentMedications: [{ type: String }],
      sideEffects: { type: String },
      suddenSugarFluctuations: { type: String },
      symptoms: [{ type: String }],
      familyHistory: { type: String },
      otherConditions: [{ type: String }],
      stressLevel: { type: String },
      monitorBloodSugar: { type: String },
      painInLiver: { type: String },
      gutIssues: { type: String },
      energyLevels: { type: String },
      sleepQuality: { type: String },
      sugarCravings: { type: String },
      durationOfDiabetes: { type: String },
      // Call checklist from Consultation.js
      checklist: {
        openingCustomerDetails: { type: Boolean, default: false },
        symptomAnalysis: { type: Boolean, default: false },
        problemExplanation: { type: Boolean, default: false },
        solutionExplanation: { type: Boolean, default: false },
        dietLifestyleGuidance: { type: Boolean, default: false },
        closingAssurance: { type: Boolean, default: false },
      },
      // Selected products from Closing.js section "Recommended Products"
      selectedProducts: [{ type: String }],
    },

    // Data coming from Closing.js
    closing: {
      consultationStatus: { type: String },  
      expectedResult: { type: String },       // Could be the option id or descriptive text
      preferredDiet: { type: String },
      courseDuration: { type: String },
      freebie: [{ type: String }],            // Now an array to support multi-select
      bloodTest: { type: String },
      bloodTestDetails: {
        address: { type: String },
        preferredTimeSlot: { type: String },
        preferredDate1: { type: String },
        preferredDate2: { type: String },
      },
    },
    
    followups: [
      {
        date: { type: String },
        takingSupplements: { type: String }, // "Yes" or "No"
        sendingGlucometerPhotos: { type: String }, // "Yes" or "No"
        currentSugar: {
          fasting: { type: String },
          pp: { type: String },
        },
        hba1cTestDone: { type: String }, // "Yes" or "No"
        hba1cValue: { type: String }, // if hba1cTestDone is "Yes"
        drop: { type: String }, // "Yes" or "No"
      }
    ],
  },
  {
    timestamps: true,
  } 
);

module.exports = mongoose.model("ConsultationDetails", ConsultationDetailsSchema);
