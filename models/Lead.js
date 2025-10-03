const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
  date: String,
  time: String,
  name: String,
  contactNumber: String,
  leadSource: String,
  enquiryFor: String,
  customerType: String,
  agentAssigned: String,
  productPitched: [String],
  leadStatus: String,
  salesStatus: String,
  nextFollowup: String,
  calculateReminder: String,
  agentsRemarks: String,
  productsOrdered: [String],
  dosageOrdered: String,
  amountPaid: Number,
  partialPayment: Number,
  modeOfPayment: String,
  deliveryStatus: String,
  healthExpertAssigned: String,
  orderId: String,
  dosageExpiring: String,
  rtNextFollowupDate: String,
  rtFollowupReminder: String,
  rtFollowupStatus: String,
  lastOrderDate: String,
  repeatDosageOrdered: String,
  retentionStatus: String,
  communicationMethod: String,
  preferredLanguage: String,
  rtRemark: String,
  rowColor: String,
  images: [ 
    {
      url: String, 
      date: Date,
      tag: String,
    }
  ],
  rtSubcells: [
    {
      date: String,
      value: String,
      by: String,
    }
  ],
  details: { 
    age: Number,
    height: Number,
    weight: Number, 
    hba1c: Number,               
    fastingSugar: Number,       
    ppSugar: Number,                
    durationOfDiabetes: String,
    lastTestDone: String,   
    totalCholesterol: Number,
    ldl: Number,
    hdl: Number,
    triglycerides: Number,
    lastCholesterolTest: String, 
    sgpt: Number,               
    sgot: Number,                   
    ggt: Number,
    ultrasoundFindings: String,     
    lastLiverTest: String, 
    gender: String,
    dietType: String, 
    sittingTime: String,
    exerciseRoutine: String, 
    outsideMeals: String,
    timeOfSleep: String,
    energyLevels: String,
    sleepQuality: String,
    gutIssues: String, 
    currentMedications: [String],
    sideEffects: String,
    suddenSugarFluctuations: String,
    familyHistory: String,
    monitorBloodSugar: String,
    sugarCravings: String,
    stressLevel: String,
    symptoms: [String],
  },
  followUps: [
    {
      date: String,
      takingSupplements: String,
      sendingGlucometerPhotos: String,
      currentSugar: {
        fasting: String,
        pp: String,
      },
      hba1cTestDone: String,
      hba1cValue: String,
      drop: String,
      note: String,
    }
  ],
  reachoutLogs: [
    {
      timestamp: { type: Date, default: Date.now },
      method: { type: String, enum: ["WhatsApp", "Call", "Both"] },
      status: {
        type: String,
        enum: [
          "CNP",
          "Followup Done",
          "Order Placed",
          "Call Back Later",
          "Busy",
          "Switch Off",
          "Drop On Intro",
        ],
      },
    },
  ],
});


LeadSchema.index({ contactNumber: 1 });

LeadSchema.index({ healthExpertAssigned: 1, salesStatus: 1, retentionStatus: 1, lastOrderDate: -1 });

LeadSchema.index({ rtNextFollowupDate: 1 });
LeadSchema.index({ rtFollowupReminder: 1 });

const Lead = mongoose.model('Lead', LeadSchema);

module.exports = Lead;