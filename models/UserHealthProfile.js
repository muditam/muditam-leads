const mongoose = require('mongoose');


// Stores a client's health profile used to drive plan generation.
// leadId can be a real Lead ObjectId (when opened from a lead record)
// or a synthetic generated ObjectId (when created via standalone onboarding).
// Upserted on save; phone is used as a secondary lookup key for standalone flow.
const UserHealthProfileSchema = new mongoose.Schema(
 {
   leadId: {
     type: mongoose.Schema.Types.ObjectId,
     index: true,
     unique: true,
     sparse: true, // allows multiple docs without leadId during transition
   },
   clientName:  { type: String, default: '' },
   clientPhone: { type: String, default: '', index: true },


   // ── Biometric inputs ──────────────────────────────────────────────────────
   gender:         { type: String, enum: ['male', 'female'], required: true },
   dateOfBirth:    { type: Date },
   age:            { type: Number, required: true },
   heightCm:       { type: Number, required: true },
   weightKg:       { type: Number, required: true },
   targetWeightKg: { type: Number },


   // ── Activity & goal ───────────────────────────────────────────────────────
   activityCode: {
     type: String,
     enum: ['AC1', 'AC2', 'AC3', 'AC4'],
     default: 'AC1',
   },
   // AC1 = Sedentary (×1.2), AC2 = Lightly active (×1.375),
   // AC3 = Moderately active (×1.55), AC4 = Very active (×1.7)


   goal: {
     type: String,
     enum: [
       'weightLoss', 'weightMaintenance', 'muscleGain', 'fatShredding',
       'diabetes', 'pcos', 'cholesterol', 'hypertension', 'thyroid',
       'ibs', 'kidneyStonesOxalate', 'pregnancy', 'lactation', 'glp1',
       'anemia', 'osteoporosis', 'uricAcid', 'heartDisease', 'liverDisease',
       'immunityBooster', 'skinHealth', 'hairHealth',
     ],
     default: 'weightLoss',
   },


   // ── Dietary preferences ───────────────────────────────────────────────────
   dietType: {
     type: String,
     enum: ['V', 'Ve', 'NV', 'E'],
     default: 'V',
   },
   // V = Vegetarian, Ve = Vegan, NV = Non-Veg, E = Eggetarian


   communityCodes: {
     type: [String],
     default: ['U'],
   },
   // U=Universal, P=Punjab/North, S=South, M=Maharashtra, G=Gujarat,
   // B=Bengal, T=Tamil Nadu, R=Karnataka, K=Kerala, A=Andhra, H=Hyderabad,
   // O=Odisha, C=Continental


   healthConditions: {
     type: [String],
     default: [],
   },


   allergies: {
     type: [String],
     default: [],
   },
   // SF=seafood, SO=shellfish, ML=dairy, F=fruits, E=eggs, N=nuts, G=gluten


   mealsPerDay: { type: Number, default: 3, min: 2, max: 8 },


   // ── Computed targets (set by the route on save) ───────────────────────────
   bmr:                { type: Number },
   tdee:               { type: Number },
   calorieTarget:      { type: Number },
   smartCalorieTarget: { type: Number },


   updatedBy: { type: String, default: '' },
 },
 { timestamps: true }
);


module.exports = mongoose.model('UserHealthProfile', UserHealthProfileSchema);



