const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema({
  purpose: { type: String, required: true },
  templateBody: { type: String, required: true },
  language: { type: String, enum: ["English", "Hindi"], default: "English" },
  createdBy: { type: String, required: true }, // Store agent's name or ID
});

module.exports = mongoose.model("Template", TemplateSchema);
