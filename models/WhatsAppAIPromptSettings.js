const mongoose = require("mongoose");


const userStampSchema = new mongoose.Schema(
 {
   id: { type: String, default: "" },
   name: { type: String, default: "" },
   email: { type: String, default: "" },
 },
 { _id: false }
);


const promptVersionSchema = new mongoose.Schema(
 {
   versionId: { type: String, required: true },
   label: { type: String, default: "" },
   helpMeWriteInstructions: {
     type: String,
     default: "",
     trim: true,
     maxlength: 12000,
   },
   createdBy: {
     type: userStampSchema,
     default: () => ({ id: "", name: "", email: "" }),
   },
   source: {
     type: String,
     enum: ["manual", "reset_default", "bootstrap"],
     default: "manual",
   },
   createdAt: { type: Date, default: Date.now },
 },
 { _id: false }
);


const WhatsAppAIPromptSettingsSchema = new mongoose.Schema(
 {
   singletonKey: {
     type: String,
     default: "default",
     unique: true,
     index: true,
   },
   helpMeWriteInstructions: {
     type: String,
     default: "",
     trim: true,
     maxlength: 12000,
   },
   activeVersionId: {
     type: String,
     default: "",
     index: true,
   },
   versions: {
     type: [promptVersionSchema],
     default: [],
   },
   updatedBy: {
     type: userStampSchema,
     default: () => ({ id: "", name: "", email: "" }),
   },
 },
 { timestamps: true }
);


module.exports = mongoose.model(
 "WhatsAppAIPromptSettings",
 WhatsAppAIPromptSettingsSchema
);



