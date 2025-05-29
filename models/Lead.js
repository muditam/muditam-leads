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
    }
  ],
  details: {
    age: Number,
    hba1c: String,
    lastTestDone: String,
    fastingSugar: String,
    ppSugar: String,
    durationOfDiabetes: String,
    gender: String,
    dietType: String,
    weight: Number,
    sittingTime: String,
    exerciseRoutine: String,
    outsideMeals: String,
    timeOfSleep: String,
    currentMedications: [String],
    sideEffects: String,
    suddenSugarFluctuations: String,
    familyHistory: String,
    monitorBloodSugar: String,
    sugarCravings: String,
    symptoms: [String],
    otherConditions: [String],
    stressLevel: String,
    painInLiver: String,
    gutIssues: String,
    energyLevels: String,
    sleepQuality: String,
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
          "OC",
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

const Lead = mongoose.model('Lead', LeadSchema);

module.exports = Lead;
