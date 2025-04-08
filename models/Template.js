const mongoose = require('mongoose');

const TemplateSchema = new mongoose.Schema({
  purpose: { type: String, required: true },
  templateBody: { type: String, required: true },
  language: { type: String, enum: ["English", "Hindi"], default: "English" },
  createdBy: { type: String, required: true }, // Store agent's name or ID
  createdByRole: {
    type: String,
    enum: ["Manager", "Sales Agent", "Retention Agent"],
    required: true,
  },
  templateFor: {
    type: String,
    enum: ["Acquisition", "Retention"],  
  },
});

module.exports = mongoose.model("Template", TemplateSchema);
