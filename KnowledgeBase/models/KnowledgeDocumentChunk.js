const mongoose = require("mongoose");


const DOC_CHANNELS = [
 "whatsapp_write_reply",
 "whatsapp_voice_call",
 "app_voice_call",
];


const DOC_CATEGORIES = [
 "product_information",
 "company_information",
 "offers",
 "support",
 "general",
];


const KnowledgeDocumentChunkSchema = new mongoose.Schema(
 {
   documentId: {
     type: mongoose.Schema.Types.ObjectId,
     ref: "KnowledgeDocument",
     required: true,
     index: true,
   },


   sourceTitle: {
     type: String,
     default: "",
     trim: true,
     maxlength: 240,
   },


   chunkIndex: {
     type: Number,
     required: true,
     min: 0,
     index: true,
   },


   chunkText: {
     type: String,
     required: true,
     trim: true,
     maxlength: 6000,
   },


   charCount: {
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
     index: true,
   },


   channels: {
     type: [String],
     enum: DOC_CHANNELS,
     default: ["whatsapp_write_reply"],
     index: true,
   },


   status: {
     type: String,
     enum: ["active", "inactive", "archived"],
     default: "active",
     index: true,
   },


   metadata: {
     type: Object,
     default: {},
   },
 },
 { timestamps: true, minimize: false }
);


KnowledgeDocumentChunkSchema.pre("save", function onSave(next) {
 const text = String(this.chunkText || "").trim();
 this.chunkText = text;
 this.charCount = text.length;


 const channels = Array.isArray(this.channels) ? this.channels : [];
 const uniq = Array.from(new Set(channels.filter((c) => DOC_CHANNELS.includes(String(c)))));
 this.channels = uniq.length ? uniq : ["whatsapp_write_reply"];


 next();
});


KnowledgeDocumentChunkSchema.index({ documentId: 1, chunkIndex: 1 }, { unique: true });
KnowledgeDocumentChunkSchema.index({ status: 1, channels: 1, category: 1, updatedAt: -1 });
KnowledgeDocumentChunkSchema.index({ chunkText: "text", sourceTitle: "text", domain: "text" });


module.exports = mongoose.model("KnowledgeDocumentChunk", KnowledgeDocumentChunkSchema);



