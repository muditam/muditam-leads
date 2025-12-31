// whatsaapModels/WhatsAppTemplate.js
const mongoose = require("mongoose");

const ButtonSchema = new mongoose.Schema(
  {
    type: { type: String, default: "" }, // QUICK_REPLY / URL / PHONE_NUMBER
    text: { type: String, default: "" },
    url: { type: String, default: "" },
    phoneNumber: { type: String, default: "" },
  },
  { _id: false }
);

const WhatsAppTemplateSchema = new mongoose.Schema(
  {
    category: { type: String, default: "" }, // MARKETING / UTILITY / AUTHENTICATION
    name: { type: String, required: true, index: true, unique: true },
    language: { type: String, default: "en" },

    header: {
      type: { type: String, default: "" }, // DOCUMENT / IMAGE / VIDEO / ""
      mediaUrl: { type: String, default: "" },
      filename: { type: String, default: "" },
    },

    body: { type: String, default: "" },
    footer: { type: String, default: "" },

    buttons: { type: [ButtonSchema], default: [] },

    sample: {
      headerMedia: { type: String, default: "" }, // optional
      variables: { type: [String], default: [] }, // ["Muditam", "12345"]
    },

    status: { type: String, default: "UNKNOWN" },
    rejectionReason: { type: String, default: "" },

    raw360: { type: mongoose.Schema.Types.Mixed, default: {} },
    syncedAt: { type: Date },
    lastSubmittedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppTemplate", WhatsAppTemplateSchema);
