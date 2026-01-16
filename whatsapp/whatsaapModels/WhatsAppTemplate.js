const mongoose = require("mongoose");

const ButtonSchema = new mongoose.Schema(
  {
    type: String,  
    text: String,
    url: String,
    phoneNumber: String,
  },
  { _id: false }
);

const WhatsAppTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    category: { type: String },  
    language: { type: String, default: "en" },

    body: { type: String, default: "" },
    footer: { type: String, default: "" },
    components: { type: Array, default: [] },
 
    headerFormat: { type: String, default: "" },  
    headerText: { type: String, default: "" },
    headerExampleHandles: { type: [String], default: [] },

    status: { type: String, default: "UNKNOWN" },  
    rejectionReason: { type: String, default: "" },

    raw360: { type: mongoose.Schema.Types.Mixed },

    syncedAt: Date,
    lastSubmittedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppTemplate", WhatsAppTemplateSchema);
