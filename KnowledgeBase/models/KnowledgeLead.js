const mongoose = require("mongoose");


function normalizePhone(value = "") {
 return String(value || "").replace(/\D/g, "").slice(-10);
}


const KnowledgeLeadSchema = new mongoose.Schema(
 {
   name: {
     type: String,
     required: true,
     trim: true,
     maxlength: 120,
   },
   phone: {
     type: String,
     required: true,
     trim: true,
     maxlength: 20,
     index: true,
   },
   normalizedPhone: {
     type: String,
     default: "",
     index: true,
   },
   source: {
     type: String,
     default: "knowledge_base",
     trim: true,
     lowercase: true,
     index: true,
   },
   kbEntryId: {
     type: mongoose.Schema.Types.ObjectId,
     ref: "KnowledgeBaseEntry",
     default: null,
   },
   metadata: {
     type: Object,
     default: {},
   },
 },
 { timestamps: true, minimize: false }
);


KnowledgeLeadSchema.pre("save", function normalize(next) {
 this.name = String(this.name || "").trim();
 this.phone = String(this.phone || "").trim();
 this.normalizedPhone = normalizePhone(this.phone);
 next();
});


module.exports = mongoose.model("KnowledgeLead", KnowledgeLeadSchema);



