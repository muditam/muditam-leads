const mongoose = require('mongoose');

const FoodSnapshotSchema = new mongoose.Schema(
 {
   foodId:        { type: mongoose.Schema.Types.Mixed },
   source:        { type: String },  
   name:          { type: String, default: '' },
   calories:      { type: Number, default: 0 },
   smartCalories: { type: Number, default: 0 },
   score:         { type: Number, default: 0 },
   protein:       { type: Number, default: 0 },
   carbs:         { type: Number, default: 0 },
   fat:           { type: Number, default: 0 },
   fiber:         { type: Number, default: 0 },
   portion:       { type: mongoose.Schema.Types.Mixed },
   portionUnit:   { type: String, default: '' },
   imageId:       { type: String, default: '' },
   foodType:      { type: String, default: '' },
   nutriScore:    { type: String, default: '' },
   brandName:     { type: String, default: '' },
   recipe:        { type: String, default: '' },
   steps:         { type: String, default: '' },
   video:         { type: String, default: '' },
   remark:        { type: String, default: '' },
   sourceUrl:     { type: String, default: '' },
   recommendedIn: { type: [String], default: [] },
   avoidIn:       { type: [String], default: [] },
   hasRecipe:     { type: Boolean, default: false },
   hasSteps:      { type: Boolean, default: false },
   hasVideo:      { type: Boolean, default: false },
   hasImage:      { type: Boolean, default: false },
   isFallbackSource: { type: Boolean, default: false },
   isConsumed:    { type: Boolean, default: false },
   consumedAt:    { type: Date, default: null },
 },
 { _id: false }
);

const SlotSchema = new mongoose.Schema(
 {
   slotIndex:          { type: Number, required: true },  // 0–8
   slotName:           { type: String, default: '' },
   mealTime:           { type: String, default: '' },
   isActive:           { type: Boolean, default: false },
   foods:              { type: [FoodSnapshotSchema], default: [] },
   totalSmartCalories: { type: Number, default: 0 },
   totalCalories:      { type: Number, default: 0 },
   totalProtein:       { type: Number, default: 0 },
   totalCarbs:         { type: Number, default: 0 },
   totalFat:           { type: Number, default: 0 },
   totalFiber:         { type: Number, default: 0 },
 },
 { _id: false }
);

const DaySchema = new mongoose.Schema(
 {
   dayIndex: { type: Number, required: true }, // 0–6
   dayLabel: { type: String, default: '' },    // 'Day 1' … 'Day 7'
   slots:    { type: [SlotSchema], default: [] },
 },
 { _id: false }
);

const SmartDietPlanSchema = new mongoose.Schema(
 {
   leadId: {
     type: mongoose.Schema.Types.ObjectId,
     ref: 'Lead',
     index: true,
   },
   clientName:  { type: String, default: '' },
   clientPhone: { type: String, default: '' },

   // Snapshot of the health profile used to generate this plan
   healthProfileSnapshot: {
     gender:           { type: String },
     age:              { type: Number },
     heightCm:         { type: Number },
     weightKg:         { type: Number },
     targetWeightKg:   { type: Number },
     activityCode:     { type: String },
     goal:             { type: String },
     dietType:         { type: String },
     communityCodes:   { type: [String], default: [] },
     healthConditions: { type: [String], default: [] },
     allergies:        { type: [String], default: [] },
     mealsPerDay:      { type: Number },
   },

   bmr:                { type: Number },
   tdee:               { type: Number },
   calorieTarget:      { type: Number },
   smartCalorieTarget: { type: Number },

   // 7-day plan (indices 0–6)
   planDays: { type: [DaySchema], default: [] },
   validationWarnings: { type: [String], default: [] },
   sourceStats: { type: mongoose.Schema.Types.Mixed, default: {} },

   status:      { type: String, enum: ['draft', 'active', 'archived'], default: 'active', index: true },
   generatedBy: { type: String, enum: ['auto', 'manual'], default: 'auto' },
   createdBy:   { type: String, default: '' },
   notes:       { type: String, default: '' },
 },
 { timestamps: true, minimize: false }
);

SmartDietPlanSchema.index({ leadId: 1, createdAt: -1 });

module.exports = mongoose.model('SmartDietPlan', SmartDietPlanSchema);

