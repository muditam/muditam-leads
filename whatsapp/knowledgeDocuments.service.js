const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");


const KnowledgeDocument = require("../KnowledgeBase/models/KnowledgeDocument");
const KnowledgeDocumentChunk = require("../KnowledgeBase/models/KnowledgeDocumentChunk");


const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "knowledge-docs");
const MAX_CHUNK_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 160;
const RETRIEVAL_STOPWORDS = new Set([
 "a",
 "an",
 "and",
 "are",
 "at",
 "be",
 "for",
 "from",
 "how",
 "i",
 "in",
 "is",
 "it",
 "its",
 "me",
 "my",
 "of",
 "on",
 "or",
 "our",
 "pls",
 "please",
 "the",
 "to",
 "us",
 "use",
 "what",
 "when",
 "where",
 "which",
 "who",
 "why",
 "you",
 "your",
 "this",
 "that",
 "kya",
 "hai",
 "ka",
 "ki",
 "ke",
]);


const INTENT_KEYWORDS = {
 pricing: [
   "cost",
   "price",
   "pricing",
   "rate",
   "mrp",
   "charges",
   "fee",
   "fees",
   "kitna",
   "kitne",
   "amount",
   "rs",
   "rupee",
   "rupees",
 ],
};


function safeStr(v) {
 return String(v ?? "").trim();
}


function normalizeText(v = "") {
 return safeStr(v)
   .replace(/\u0000/g, " ")
   .replace(/\r/g, "\n")
   .replace(/\n{3,}/g, "\n\n")
   .replace(/[ \t]+/g, " ")
   .trim();
}


function normalizeForMatch(v = "") {
 return safeStr(v)
   .toLowerCase()
   .replace(/[^a-z0-9\s]/g, " ")
   .replace(/\s+/g, " ")
   .trim();
}


function getFileExt(filename = "") {
 return safeStr(filename).toLowerCase().split(".").pop() || "";
}


function detectFileKind({ originalName = "", mimeType = "" }) {
 const ext = getFileExt(originalName);
 const mime = safeStr(mimeType).toLowerCase();


 if (ext === "pdf" || mime.includes("pdf")) return "pdf";
 if (ext === "docx" || mime.includes("officedocument.wordprocessingml.document")) return "docx";
 if (["txt", "md", "csv", "tsv"].includes(ext) || mime.startsWith("text/")) return "text";
 if (ext === "doc") return "doc";
 return "unknown";
}


function chunkText(text = "") {
 const raw = normalizeText(text);
 if (!raw) return [];


 const paragraphs = raw
   .split(/\n\n+/)
   .map((p) => p.trim())
   .filter(Boolean);


 const chunks = [];
 let current = "";


 function pushCurrent() {
   const v = current.trim();
   if (v) chunks.push(v);
   current = "";
 }


 for (const para of paragraphs) {
   if (!current) {
     current = para;
     continue;
   }


   const candidate = `${current}\n\n${para}`;
   if (candidate.length <= MAX_CHUNK_CHARS) {
     current = candidate;
     continue;
   }


   pushCurrent();


   if (para.length <= MAX_CHUNK_CHARS) {
     current = para;
     continue;
   }


   let start = 0;
   while (start < para.length) {
     const end = Math.min(para.length, start + MAX_CHUNK_CHARS);
     const part = para.slice(start, end).trim();
     if (part) chunks.push(part);
     if (end >= para.length) break;
     start = Math.max(end - CHUNK_OVERLAP_CHARS, 0);
     if (start >= end) break;
   }
 }


 pushCurrent();


 return chunks;
}


async function ensureUploadDir() {
 await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}


async function writeUploadFile({ buffer, originalName }) {
 await ensureUploadDir();


 const ext = getFileExt(originalName);
 const stamp = Date.now();
 const rand = crypto.randomBytes(8).toString("hex");
 const safeBase = safeStr(path.basename(originalName, path.extname(originalName)))
   .replace(/[^a-zA-Z0-9_-]/g, "_")
   .slice(0, 50) || "document";


 const filename = `${stamp}_${rand}_${safeBase}${ext ? `.${ext}` : ""}`;
 const absPath = path.join(UPLOAD_DIR, filename);


 await fsp.writeFile(absPath, buffer);


 return {
   absPath,
   relativePath: path.join("uploads", "knowledge-docs", filename),
 };
}


async function extractTextFromBuffer({ buffer, originalName, mimeType }) {
 const kind = detectFileKind({ originalName, mimeType });


 if (kind === "text") {
   return {
     text: normalizeText(buffer.toString("utf8")),
     extractionStatus: "success",
     fileType: getFileExt(originalName) || "txt",
     error: "",
   };
 }


 if (kind === "pdf") {
   let parser = null;
   try {
     const pdfParseModule = require("pdf-parse");
     let out = null;


     if (typeof pdfParseModule === "function") {
       // Backward compatibility: pdf-parse v1 exported a callable function.
       out = await pdfParseModule(buffer);
     } else if (typeof pdfParseModule?.PDFParse === "function") {
       // pdf-parse v2 exposes the PDFParse class.
       parser = new pdfParseModule.PDFParse({ data: buffer });
       out = await parser.getText();
     } else {
       throw new Error("Unsupported pdf-parse module export");
     }


     return {
       text: normalizeText(out?.text || ""),
       extractionStatus: "success",
       fileType: "pdf",
       error: "",
     };
   } catch (e) {
     return {
       text: "",
       extractionStatus: "failed",
       fileType: "pdf",
       error: `PDF extraction failed: ${e?.message || String(e)}`,
     };
   } finally {
     if (parser && typeof parser.destroy === "function") {
       await parser.destroy().catch(() => null);
     }
   }
 }


 if (kind === "docx") {
   try {
     const mammoth = require("mammoth");
     const out = await mammoth.extractRawText({ buffer });
     return {
       text: normalizeText(out?.value || ""),
       extractionStatus: "success",
       fileType: "docx",
       error: "",
     };
   } catch (e) {
     return {
       text: "",
       extractionStatus: "failed",
       fileType: "docx",
       error: `DOCX extraction failed: ${e?.message || String(e)}`,
     };
   }
 }


 if (kind === "doc") {
   return {
     text: "",
     extractionStatus: "failed",
     fileType: "doc",
     error:
       "DOC extraction is not supported in this version. Please convert to DOCX or PDF and upload again.",
   };
 }


 return {
   text: "",
   extractionStatus: "failed",
   fileType: getFileExt(originalName) || "unknown",
   error:
     "Unsupported file type. Use PDF, DOCX, TXT, MD, CSV, or TSV for knowledge ingestion.",
 };
}


async function upsertChunksForDocument({
 documentId,
 title,
 text,
 category,
 domain,
 channels,
 status,
}) {
 const chunks = chunkText(text);


 await KnowledgeDocumentChunk.deleteMany({ documentId });


 if (!chunks.length) {
   return { chunkCount: 0 };
 }


 const docs = chunks.map((chunkTextValue, index) => ({
   documentId,
   sourceTitle: title,
   chunkIndex: index,
   chunkText: chunkTextValue,
   category,
   domain,
   channels,
   status,
 }));


 await KnowledgeDocumentChunk.insertMany(docs, { ordered: false });


 return { chunkCount: chunks.length };
}


async function processAndStoreKnowledgeDocument({
 file,
 title,
 category,
 domain,
 tags,
 channels,
 status,
 actor,
}) {
 if (!file || !file.buffer) {
   throw new Error("No file buffer provided");
 }


 const originalFileName = safeStr(file.originalname) || "document";
 const mimeType = safeStr(file.mimetype).toLowerCase();


 const storage = await writeUploadFile({
   buffer: file.buffer,
   originalName: originalFileName,
 });


 const extracted = await extractTextFromBuffer({
   buffer: file.buffer,
   originalName: originalFileName,
   mimeType,
 });


 const normalizedText = normalizeText(extracted.text || "");


 const doc = await KnowledgeDocument.create({
   title: safeStr(title) || originalFileName,
   originalFileName,
   fileType: extracted.fileType,
   mimeType,
   sizeBytes: Number(file.size || 0),
   category,
   domain,
   tags,
   channels,
   status,
   extractionStatus: extracted.extractionStatus,
   extractionError: extracted.error || "",
   extractedTextLength: normalizedText.length,
   extractedTextPreview: normalizedText.slice(0, 1800),
   chunkCount: 0,
   storage: {
     provider: "local",
     localPath: storage.absPath,
     relativePath: storage.relativePath,
   },
   sourceType: "upload",
   createdBy: actor || {},
   updatedBy: actor || {},
 });


 if (extracted.extractionStatus === "success" && normalizedText) {
   const { chunkCount } = await upsertChunksForDocument({
     documentId: doc._id,
     title: doc.title,
     text: normalizedText,
     category: doc.category,
     domain: doc.domain,
     channels: doc.channels,
     status: doc.status,
   });


   doc.chunkCount = chunkCount;
   await doc.save();
 }


 return doc;
}


async function reprocessDocument(documentId, actor = null) {
 const doc = await KnowledgeDocument.findById(documentId);
 if (!doc) throw new Error("Document not found");


 const localPath = safeStr(doc?.storage?.localPath);
 if (!localPath || !fs.existsSync(localPath)) {
   throw new Error("Stored file not found on server");
 }


 const buffer = await fsp.readFile(localPath);
 const extracted = await extractTextFromBuffer({
   buffer,
   originalName: doc.originalFileName,
   mimeType: doc.mimeType,
 });


 const normalizedText = normalizeText(extracted.text || "");


 doc.extractionStatus = extracted.extractionStatus;
 doc.extractionError = extracted.error || "";
 doc.extractedTextLength = normalizedText.length;
 doc.extractedTextPreview = normalizedText.slice(0, 1800);
 if (actor) doc.updatedBy = actor;


 if (extracted.extractionStatus === "success" && normalizedText) {
   const { chunkCount } = await upsertChunksForDocument({
     documentId: doc._id,
     title: doc.title,
     text: normalizedText,
     category: doc.category,
     domain: doc.domain,
     channels: doc.channels,
     status: doc.status,
   });
   doc.chunkCount = chunkCount;
 } else {
   await KnowledgeDocumentChunk.deleteMany({ documentId: doc._id });
   doc.chunkCount = 0;
 }


 await doc.save();
 return doc;
}


async function syncDocumentChunksMetadata(documentId, payload = {}) {
 await KnowledgeDocumentChunk.updateMany(
   { documentId },
   {
     $set: {
       ...(payload.title !== undefined ? { sourceTitle: safeStr(payload.title) } : {}),
       ...(payload.category !== undefined ? { category: payload.category } : {}),
       ...(payload.domain !== undefined ? { domain: safeStr(payload.domain).toLowerCase() } : {}),
       ...(payload.channels !== undefined ? { channels: payload.channels } : {}),
       ...(payload.status !== undefined ? { status: payload.status } : {}),
     },
   }
 );
}


function buildRegexTokens(text = "") {
 const norm = normalizeForMatch(text);
 if (!norm) return [];
 const unique = Array.from(
   new Set(
     norm
       .split(" ")
       .map((t) => t.trim())
       .filter((t) => t.length > 2 && !RETRIEVAL_STOPWORDS.has(t))
   )
 );
 return unique.slice(0, 10);
}


function isPricingIntent(question = "") {
 const norm = normalizeForMatch(question);
 if (!norm) return false;
 return INTENT_KEYWORDS.pricing.some((k) => norm.includes(k));
}


function expandRetrievalTokens(question = "") {
 const base = buildRegexTokens(question);
 const set = new Set(base);


 if (isPricingIntent(question)) {
   for (const token of INTENT_KEYWORDS.pricing) {
     set.add(token);
   }
 }


 return Array.from(set);
}


function scoreCandidateChunk(chunk, tokens = [], { pricingIntent = false } = {}) {
 const hay = normalizeForMatch(`${safeStr(chunk?.sourceTitle)} ${safeStr(chunk?.chunkText)}`);
 let tokenHits = 0;
 for (const token of tokens) {
   if (!token) continue;
   if (hay.includes(token)) tokenHits += 1;
 }


 const textScore = Number(chunk?.score || 0);
 const hitScore = Math.min(tokenHits * 0.07, 0.56);
 const pricingBoost =
   pricingIntent && /(pricing|price|mrp|rs\.?|rupees?|cost)/i.test(safeStr(chunk?.chunkText))
     ? 0.24
     : 0;


 return textScore + hitScore + pricingBoost;
}


async function retrieveRelevantDocumentChunks({
 query,
 channel = "whatsapp_write_reply",
 maxChunks = 4,
}) {
 const question = safeStr(query);
 if (!question) return [];


 const baseFilter = {
   status: "active",
   channels: channel,
 };


 const retrievalTokens = expandRetrievalTokens(question);
 const textSearchQuery = retrievalTokens.length ? retrievalTokens.join(" ") : question;
 const pricingIntent = isPricingIntent(question);
 const fetchLimit = Math.max(maxChunks * 8, 24);


 let chunks = [];


 try {
   chunks = await KnowledgeDocumentChunk.find(
     {
       ...baseFilter,
       $text: { $search: textSearchQuery },
     },
     {
       score: { $meta: "textScore" },
       chunkText: 1,
       sourceTitle: 1,
       category: 1,
       domain: 1,
       chunkIndex: 1,
       documentId: 1,
     }
   )
     .sort({ score: { $meta: "textScore" } })
     .limit(fetchLimit)
     .lean();
 } catch (e) {
   console.error("document text search failed:", e?.message || e);
 }


 if (!chunks.length) {
   const regexList = retrievalTokens.map((t) => new RegExp(`\\b${t}\\b`, "i"));
   if (!regexList.length) return [];


   const fallback = await KnowledgeDocumentChunk.find({
     ...baseFilter,
     $or: [
       ...regexList.map((r) => ({ chunkText: r })),
       ...regexList.map((r) => ({ sourceTitle: r })),
     ],
   })
     .sort({ updatedAt: -1 })
     .limit(fetchLimit)
     .lean();


   chunks = fallback.map((c) => ({
     ...c,
     score: scoreCandidateChunk(c, retrievalTokens, { pricingIntent }),
   }));
 }


 if (!chunks.length) return [];


 const ranked = chunks
   .map((chunk) => ({
     ...chunk,
     _rank: scoreCandidateChunk(chunk, retrievalTokens, { pricingIntent }),
   }))
   .sort((a, b) => Number(b._rank || 0) - Number(a._rank || 0));


 const selected = [];
 const perDocLimit = 2;
 const docCount = new Map();


 for (const chunk of ranked) {
   const docKey = String(chunk.documentId || "");
   if (!docKey) continue;


   const used = Number(docCount.get(docKey) || 0);
   if (used >= perDocLimit) continue;


   selected.push(chunk);
   docCount.set(docKey, used + 1);


   if (selected.length >= maxChunks) break;
 }


 return selected.map((chunk) => ({
     documentId: chunk.documentId,
     sourceTitle: safeStr(chunk.sourceTitle),
     category: safeStr(chunk.category),
     domain: safeStr(chunk.domain),
     chunkIndex: Number(chunk.chunkIndex || 0),
     score: Number(chunk._rank || chunk.score || 0),
     text: safeStr(chunk.chunkText),
   }));
}


async function deleteKnowledgeDocument(documentId) {
 const doc = await KnowledgeDocument.findById(documentId);
 if (!doc) return null;


 await KnowledgeDocumentChunk.deleteMany({ documentId: doc._id });


 const localPath = safeStr(doc?.storage?.localPath);
 if (localPath && fs.existsSync(localPath)) {
   try {
     await fsp.unlink(localPath);
   } catch (e) {
     console.error("document file delete failed:", e?.message || e);
   }
 }


 await KnowledgeDocument.deleteOne({ _id: doc._id });


 return doc;
}


module.exports = {
 processAndStoreKnowledgeDocument,
 reprocessDocument,
 syncDocumentChunksMetadata,
 retrieveRelevantDocumentChunks,
 deleteKnowledgeDocument,
 chunkText,
 normalizeText,
 normalizeForMatch,
 detectFileKind,
 UPLOAD_DIR,
};



