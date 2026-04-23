const mongoose = require("mongoose");


const KB_CHANNELS = [
 "whatsapp_write_reply",
 "whatsapp_voice_call",
 "app_voice_call",
];


const KB_STATUSES = ["active", "inactive", "archived"];
const KB_INTENTS = ["sales", "support", "complaint", "order", "refund"];
const KB_STAGES = ["new_user", "existing_customer"];
const KB_PRIORITIES = ["high", "medium", "low"];
const KB_NEXT_ACTION_TYPES = ["collect_lead", "suggest_product", "handoff", "none"];


const userStampSchema = new mongoose.Schema(
 {
   id: { type: String, default: "" },
   name: { type: String, default: "" },
   email: { type: String, default: "" },
 },
 { _id: false }
);


const nextActionSchema = new mongoose.Schema(
 {
   type: {
     type: String,
     enum: KB_NEXT_ACTION_TYPES,
     default: "none",
   },
   payload: {
     type: Object,
     default: {},
   },
 },
 { _id: false }
);


const versionSchema = new mongoose.Schema(
 {
   answer: { type: String, default: "" },
   updatedAt: { type: Date, default: Date.now },
   updatedBy: { type: String, default: "" },
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


function cleanStringList(list = []) {
 const arr = Array.isArray(list) ? list : [list];
 const out = [];
 const seen = new Set();


 for (const item of arr) {
   const value = String(item || "").trim();
   if (!value) continue;
   const key = value.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   out.push(value);
 }


 return out;
}


const KnowledgeBaseEntrySchema = new mongoose.Schema(
 {
   intentCode: {
     type: String,
     trim: true,
     maxlength: 120,
     sparse: true,
     index: true,
     unique: true,
   },


   canonicalQuestion: {
     type: String,
     required: true,
     trim: true,
     maxlength: 500,
   },
   normalizedCanonicalQuestion: {
     type: String,
     default: "",
     index: true,
   },


   alternateQuestions: {
     type: [String],
     default: [],
   },


   answer: {
     type: String,
     required: true,
     trim: true,
     maxlength: 8000,
   },


   domain: {
     type: String,
     default: "general",
     trim: true,
     lowercase: true,
     index: true,
   },


   tags: {
     type: [String],
     default: [],
   },


   channels: {
     type: [String],
     enum: KB_CHANNELS,
     default: ["whatsapp_write_reply"],
     index: true,
   },


   status: {
     type: String,
     enum: KB_STATUSES,
     default: "active",
     index: true,
   },


   source: {
     type: String,
     enum: ["manual", "gap_resolution", "imported", "system"],
     default: "manual",
   },


   intent: {
     type: String,
     enum: KB_INTENTS,
     default: "support",
     index: true,
   },


   stage: {
     type: String,
     enum: KB_STAGES,
     default: "new_user",
     index: true,
   },


   priority: {
     type: String,
     enum: KB_PRIORITIES,
     default: "medium",
     index: true,
   },


   nextAction: {
     type: nextActionSchema,
     default: () => ({ type: "none", payload: {} }),
   },


   usageCount: { type: Number, default: 0 },
   successCount: { type: Number, default: 0 },
   failureCount: { type: Number, default: 0 },
   handoffCount: { type: Number, default: 0 },


   versions: {
     type: [versionSchema],
     default: [],
   },


   usage: {
     helpWriteHits: { type: Number, default: 0 },
     lastUsedAt: { type: Date, default: null },
   },


   quality: {
     reviewStatus: {
       type: String,
       enum: ["draft", "reviewed", "approved"],
       default: "reviewed",
     },
     lastReviewedAt: { type: Date, default: null },
   },


   createdBy: {
     type: userStampSchema,
     default: () => ({ id: "", name: "", email: "" }),
   },
   updatedBy: {
     type: userStampSchema,
     default: () => ({ id: "", name: "", email: "" }),
   },


   metadata: {
     type: Object,
     default: {},
   },
 },
 { timestamps: true, minimize: false }
);


KnowledgeBaseEntrySchema.pre("save", function onSave(next) {
 this.canonicalQuestion = String(this.canonicalQuestion || "").trim();
 this.answer = String(this.answer || "").trim();


 this.alternateQuestions = cleanStringList(this.alternateQuestions);
 this.tags = cleanStringList(this.tags).map((t) => t.toLowerCase());


 this.normalizedCanonicalQuestion = normalizeText(this.canonicalQuestion);


 const channels = Array.isArray(this.channels) ? this.channels : [];
 const channelSet = new Set(channels.filter((c) => KB_CHANNELS.includes(c)));
 if (channelSet.size === 0) channelSet.add("whatsapp_write_reply");
 this.channels = Array.from(channelSet);


 next();
});


KnowledgeBaseEntrySchema.index({ status: 1, channels: 1, updatedAt: -1 });
KnowledgeBaseEntrySchema.index({ domain: 1, status: 1, updatedAt: -1 });


module.exports = mongoose.model("KnowledgeBaseEntry", KnowledgeBaseEntrySchema);
module.exports.KB_CHANNELS = KB_CHANNELS;
module.exports.KB_STATUSES = KB_STATUSES;
module.exports.KB_INTENTS = KB_INTENTS;
module.exports.KB_STAGES = KB_STAGES;
module.exports.KB_PRIORITIES = KB_PRIORITIES;
module.exports.KB_NEXT_ACTION_TYPES = KB_NEXT_ACTION_TYPES;



