const mongoose = require("mongoose");


const GAP_CHANNELS = [
 "whatsapp_write_reply",
 "whatsapp_voice_call",
 "app_voice_call",
];


const userStampSchema = new mongoose.Schema(
 {
   id: { type: String, default: "" },
   name: { type: String, default: "" },
   email: { type: String, default: "" },
 },
 { _id: false }
);


function normalizeText(v = "") {
 return String(v || "")
   .toLowerCase()
   .replace(/[^a-z0-9\s]/g, " ")
   .replace(/\s+/g, " ")
   .trim();
}


const KnowledgeGapSchema = new mongoose.Schema(
 {
   questionText: {
     type: String,
     required: true,
     trim: true,
     maxlength: 1000,
   },


   normalizedQuestion: {
     type: String,
     default: "",
     index: true,
   },


   channel: {
     type: String,
     enum: GAP_CHANNELS,
     default: "whatsapp_write_reply",
     index: true,
   },


   status: {
     type: String,
     enum: ["open", "answered", "ignored"],
     default: "open",
     index: true,
   },


   phone: { type: String, default: "", index: true },
   leadName: { type: String, default: "" },


   transcriptSnippet: {
     type: String,
     default: "",
     maxlength: 4000,
   },


   occurrenceCount: {
     type: Number,
     default: 1,
     min: 1,
   },


   firstSeenAt: {
     type: Date,
     default: Date.now,
     index: true,
   },


   lastSeenAt: {
     type: Date,
     default: Date.now,
     index: true,
   },


   resolvedAt: { type: Date, default: null },
   resolvedBy: {
     type: userStampSchema,
     default: () => ({ id: "", name: "", email: "" }),
   },


   resolution: {
     knowledgeEntryId: {
       type: mongoose.Schema.Types.ObjectId,
       ref: "KnowledgeBaseEntry",
       default: null,
     },
     answer: { type: String, default: "" },
     notes: { type: String, default: "" },
   },


   metadata: {
     type: Object,
     default: {},
   },
 },
 { timestamps: true, minimize: false }
);


KnowledgeGapSchema.pre("save", function onSave(next) {
 this.questionText = String(this.questionText || "").trim();
 this.normalizedQuestion = normalizeText(this.questionText);
 this.transcriptSnippet = String(this.transcriptSnippet || "").trim();
 next();
});


KnowledgeGapSchema.index({ channel: 1, status: 1, lastSeenAt: -1 });
KnowledgeGapSchema.index({ normalizedQuestion: 1, channel: 1, status: 1 });


module.exports = mongoose.model("KnowledgeGap", KnowledgeGapSchema);
module.exports.GAP_CHANNELS = GAP_CHANNELS;



