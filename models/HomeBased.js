const mongoose = require("mongoose");


const HomeBasedSchema = new mongoose.Schema(
 {
   _id: { type: mongoose.Schema.Types.Mixed, required: true },
   Food: mongoose.Schema.Types.Mixed,
   Score: mongoose.Schema.Types.Mixed,
   Type: mongoose.Schema.Types.Mixed,
   portion_unit: mongoose.Schema.Types.Mixed,
   portion: mongoose.Schema.Types.Mixed,
   Community: mongoose.Schema.Types.Mixed,
   Calories: mongoose.Schema.Types.Mixed,
   SmartCalories: mongoose.Schema.Types.Mixed,
   Carbs: mongoose.Schema.Types.Mixed,
   Protien: mongoose.Schema.Types.Mixed,
   Fat: mongoose.Schema.Types.Mixed,
   Fiber: mongoose.Schema.Types.Mixed,
   foodType: mongoose.Schema.Types.Mixed,
   Priority: mongoose.Schema.Types.Mixed,
   imageId: mongoose.Schema.Types.Mixed,
   search_keyword: mongoose.Schema.Types.Mixed,
 },
 {
   strict: false,
   versionKey: false,
   collection: "homeBased",
 }
);


module.exports = mongoose.model("HomeBased", HomeBasedSchema);



