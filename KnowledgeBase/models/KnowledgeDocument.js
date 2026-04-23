const mongoose = require("mongoose");


const DOC_CATEGORIES = [
 "product_information",
 "company_information",
 "offers",
 "support",
 "general",
];


const DOC_CHANNELS = [
 "whatsapp_write_reply",
 "whatsapp_voice_call",
 "app_voice_call",
];


const DOC_STATUSES = ["active", "inactive", "archived"];


const userStampSchema = new mongoose.Schema(
 {
   id: { type: String, default: "" },
   name: { type: String, default: "" },
   email: { type: String, default: "" },
 },
 { _id: false }
);


function safeStr(v) {
 return String(v ?? "").trim();
}


function cleanList(values = [], { lowercase = false } = {}) {
 const arr = Array.isArray(values) ? values : [values];
 const out = [];
 const seen = new Set();


 for (const item of arr) {
   const raw = safeStr(item);
   if (!raw) continue;
   const value = lowercase ? raw.toLowerCase() : raw;
   const key = value.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   out.push(value);
 }


 return out;
}


const KnowledgeDocumentSchema = new mongoose.Schema(
 {
   title: {
     type: String,
     required: true,
     trim: true,
     maxlength: 240,
     index: true,
   },


   originalFileName: {
     type: String,
     required: true,
     trim: true,
     maxlength: 500,
   },


   fileType: {
     type: String,
     default: "",
     trim: true,
     lowercase: true,
     maxlength: 20,
   },


   mimeType: {
     type: String,
     default: "",
     trim: true,
     lowercase: true,
     maxlength: 120,
   },


   sizeBytes: {
     type: Number,
     default: 0,
     min: 0,
   },


   category: {
     type: String,
     enum: DOC_CATEGORIES,
     default: "general",
     index: true,
   },


   domain: {
     type: String,
     default: "sales",
     trim: true,
     lowercase: true,
     maxlength: 80,
     index: true,
   },


   tags: {
     type: [String],
     default: [],
   },


   channels: {
     type: [String],
     enum: DOC_CHANNELS,
     default: ["whatsapp_write_reply"],
     index: true,
   },


   status: {
     type: String,
     enum: DOC_STATUSES,
     default: "active",
     index: true,
   },


   extractionStatus: {
     type: String,
     enum: ["pending", "success", "failed"],
     default: "pending",
     index: true,
   },


   extractionError: {
     type: String,
     default: "",
     maxlength: 1200,
   },


   extractedTextLength: {
     type: Number,
     default: 0,
     min: 0,
   },


   extractedTextPreview: {
     type: String,
     default: "",
     maxlength: 2000,
   },


   chunkCount: {
     type: Number,
     default: 0,
     min: 0,
   },


   storage: {
     provider: { type: String, default: "local" },
     localPath: { type: String, default: "" },
     relativePath: { type: String, default: "" },
   },


   sourceType: {
     type: String,
     enum: ["upload", "manual"],
     default: "upload",
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


KnowledgeDocumentSchema.pre("save", function onSave(next) {
 this.title = safeStr(this.title);
 this.originalFileName = safeStr(this.originalFileName);
 this.fileType = safeStr(this.fileType).toLowerCase();
 this.mimeType = safeStr(this.mimeType).toLowerCase();


 this.tags = cleanList(this.tags, { lowercase: true });


 const channels = cleanList(this.channels, { lowercase: true });
 const valid = channels.filter((c) => DOC_CHANNELS.includes(c));
 this.channels = valid.length ? valid : ["whatsapp_write_reply"];


 next();
});


KnowledgeDocumentSchema.index({ status: 1, channels: 1, updatedAt: -1 });
KnowledgeDocumentSchema.index({ category: 1, status: 1, updatedAt: -1 });
KnowledgeDocumentSchema.index({ extractionStatus: 1, status: 1, updatedAt: -1 });


module.exports = mongoose.model("KnowledgeDocument", KnowledgeDocumentSchema);
module.exports.DOC_CATEGORIES = DOC_CATEGORIES;
module.exports.DOC_CHANNELS = DOC_CHANNELS;
module.exports.DOC_STATUSES = DOC_STATUSES;



