// models/DietTemplate.js
const mongoose = require("mongoose");

const DietTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["weekly-14", "monthly-options"],
      required: true,
      index: true,
    },
    category: { type: String },
    tags: { type: [String], default: [], index: true },
    status: {
      type: String,
      enum: ["draft", "published", "archived"], 
      index: true,
    },
    version: { type: Number, default: 1 },
    body: { type: mongoose.Schema.Types.Mixed, required: true },  

    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DietTemplate", DietTemplateSchema);
