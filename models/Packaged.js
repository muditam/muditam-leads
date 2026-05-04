const mongoose = require("mongoose");


const PackagedSchema = new mongoose.Schema(
 {
   _id: { type: mongoose.Schema.Types.Mixed, required: true },
   Food: mongoose.Schema.Types.Mixed,
   brandName: mongoose.Schema.Types.Mixed,
   brand: mongoose.Schema.Types.Mixed,
   foodSource: mongoose.Schema.Types.Mixed,
   unitCalories: mongoose.Schema.Types.Mixed,
   unitCarbs: mongoose.Schema.Types.Mixed,
   unitProtein: mongoose.Schema.Types.Mixed,
   unitFat: mongoose.Schema.Types.Mixed,
   unitFiber: mongoose.Schema.Types.Mixed,
   unitSugars: mongoose.Schema.Types.Mixed,
   unitSodium: mongoose.Schema.Types.Mixed,
   unitSaturatedFat: mongoose.Schema.Types.Mixed,
   nutriScore: mongoose.Schema.Types.Mixed,
   nutriScoreSDP: mongoose.Schema.Types.Mixed,
   nutriScoreColor: mongoose.Schema.Types.Mixed,
   updatedBy: mongoose.Schema.Types.Mixed,
   editor: mongoose.Schema.Types.Mixed,
   portion_gms: mongoose.Schema.Types.Mixed,
   measuring_unit: mongoose.Schema.Types.Mixed,
   portion: mongoose.Schema.Types.Mixed,
   portion_unit: mongoose.Schema.Types.Mixed,
   foodType: mongoose.Schema.Types.Mixed,
   Type: mongoose.Schema.Types.Mixed,
   categorisationUpdatedBy: mongoose.Schema.Types.Mixed,
   Calories: mongoose.Schema.Types.Mixed,
   Carbs: mongoose.Schema.Types.Mixed,
   Fat: mongoose.Schema.Types.Mixed,
   Protein: mongoose.Schema.Types.Mixed,
   Fiber: mongoose.Schema.Types.Mixed,
   brandLogo: mongoose.Schema.Types.Mixed,
   Score: mongoose.Schema.Types.Mixed,
   smartCalories: mongoose.Schema.Types.Mixed,
   brandID: mongoose.Schema.Types.Mixed,
   imageId: mongoose.Schema.Types.Mixed,
   Remark: mongoose.Schema.Types.Mixed,
   barCode: mongoose.Schema.Types.Mixed,
   healthyitemflag_weightloss: mongoose.Schema.Types.Mixed,
   healthyitemflag_diabetes: mongoose.Schema.Types.Mixed,
   search_keyword: mongoose.Schema.Types.Mixed,
 },
 {
   strict: false,
   versionKey: false,
   collection: "Packaged",
 }
);


module.exports = mongoose.model("Packaged", PackagedSchema);



