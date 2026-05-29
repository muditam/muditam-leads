const mongoose = require("mongoose");

const TemplateButtonSchema = new mongoose.Schema(
  {
    type: { type: String, default: "" },
    text: { type: String, default: "" },
    url: { type: String, default: "" },
    phoneNumber: { type: String, default: "" },
    payload: { type: String, default: "" },
  },
  { _id: false }
);

const WhatsAppMessageSchema = new mongoose.Schema(
  {
    waId: { type: String, index: true },
    providerTransactionId: { type: String, index: true },
    from: { type: String, index: true },
    to: { type: String, index: true },

    text: { type: String, default: "" },  
    type: { type: String, default: "text" },  
    direction: { type: String, enum: ["INBOUND", "OUTBOUND"], index: true },
 
    media: {
      id: { type: String, default: "" },
      url: { type: String, default: "" },     
      mime: { type: String, default: "" },
      filename: { type: String, default: "" },
    },

    // optional: keep caption separately (if you want)
    caption: { type: String, default: "" },

    // optional: store template info (helpful)
    templateMeta: {
      name: { type: String, default: "" },
      templateId: { type: String, default: "" },
      language: { type: String, default: "" },
      parameters: { type: [String], default: [] },
      headerMedia: { type: Object, default: null },
      buttons: { type: [TemplateButtonSchema], default: [] },
    },

    status: String,
    timestamp: { type: Date, index: true },
    raw: Object,
  },
  { timestamps: true }
);

// useful compound index for fast chat fetch
WhatsAppMessageSchema.index({ from: 1, to: 1, timestamp: 1 });

module.exports = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);
