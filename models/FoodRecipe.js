const mongoose = require("mongoose");


const FoodRecipeSchema = new mongoose.Schema(
 {
   code: { type: mongoose.Schema.Types.Mixed, required: true },
   message: mongoose.Schema.Types.Mixed,
   foodItem: mongoose.Schema.Types.Mixed,
   Name: mongoose.Schema.Types.Mixed,
   recipe: mongoose.Schema.Types.Mixed,
   steps: mongoose.Schema.Types.Mixed,
   video: mongoose.Schema.Types.Mixed,
   courtesy: mongoose.Schema.Types.Mixed,
   Protien: mongoose.Schema.Types.Mixed,
   Carbs: mongoose.Schema.Types.Mixed,
   Fiber: mongoose.Schema.Types.Mixed,
   Fat: mongoose.Schema.Types.Mixed,
   Calories: mongoose.Schema.Types.Mixed,
   portion: mongoose.Schema.Types.Mixed,
   remark: mongoose.Schema.Types.Mixed,
   avoidIn: mongoose.Schema.Types.Mixed,
   recommendedIn: mongoose.Schema.Types.Mixed,
   imageId: mongoose.Schema.Types.Mixed,
   portionUnit: mongoose.Schema.Types.Mixed,
   type: mongoose.Schema.Types.Mixed,
   foodType: mongoose.Schema.Types.Mixed,
   nutriScore: mongoose.Schema.Types.Mixed,
   factorZ: mongoose.Schema.Types.Mixed,
   recommendedFor: mongoose.Schema.Types.Mixed,
   community: mongoose.Schema.Types.Mixed,
   smartCalories: mongoose.Schema.Types.Mixed,
   source: mongoose.Schema.Types.Mixed,
   Score: mongoose.Schema.Types.Mixed,
 },
 {
   strict: false,
   versionKey: false,
   collection: "food_recipes",
 }
);


FoodRecipeSchema.index({ code: 1 });


module.exports = mongoose.model("FoodRecipe", FoodRecipeSchema);



