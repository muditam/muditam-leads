const mongoose = require("mongoose");

// Flexible schema for existing food_by_cat records used in image migration.
// _id can be number/string/objectId depending on historical imports.
const FoodByCatSchema = new mongoose.Schema(
  {
    _id: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  {
    strict: false,
    versionKey: false,
    collection: "food_by_cat",
  }
);

module.exports = mongoose.model("FoodByCat", FoodByCatSchema);
