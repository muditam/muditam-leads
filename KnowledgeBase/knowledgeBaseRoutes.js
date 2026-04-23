const express = require("express");
const path = require("path");
const multer = require("multer");
const OpenAI = require("openai");


const requireSession = require("../middleware/requireSession");
const KnowledgeBaseEntry = require("./models/KnowledgeBaseEntry");
const KnowledgeGap = require("./models/KnowledgeGap");
const KnowledgeDocument = require("./models/KnowledgeDocument");
const KnowledgeDocumentChunk = require("./models/KnowledgeDocumentChunk");
const {
 processAndStoreKnowledgeDocument,
 reprocessDocument,
 syncDocumentChunksMetadata,
 deleteKnowledgeDocument,
 retrieveRelevantDocumentChunks,
} = require("../whatsapp/knowledgeDocuments.service");
const {
 findBestKnowledgeEntry,
 touchKnowledgeUsage,
 incrementKnowledgePerformance,
 normalizeText,
 tokenize,
} = require("../whatsapp/knowledgeBase.service");


const KB_CHANNELS = [
 "whatsapp_write_reply",
 "whatsapp_voice_call",
 "app_voice_call",
];
const ENTRY_STATUSES = new Set(["active", "inactive", "archived"]);
const ENTRY_SOURCES = new Set(["manual", "gap_resolution", "imported", "system"]);
const REVIEW_STATUSES = new Set(["draft", "reviewed", "approved"]);
const ENTRY_INTENTS = new Set(["sales", "support", "complaint", "order", "refund"]);
const ENTRY_STAGES = new Set(["new_user", "existing_customer"]);
const ENTRY_PRIORITIES = new Set(["high", "medium", "low"]);
const NEXT_ACTION_TYPES = new Set(["collect_lead", "suggest_product", "handoff", "none"]);
const MIN_CONFIDENCE_SCORE = 0.6;
const MIN_POTENTIAL_MATCH_SCORE = 0.35;
const LOW_CONFIDENCE_FALLBACK =
 "I want to make sure you get the right help. Let me connect you with our support team.";
const DOCUMENT_CATEGORIES = new Set([
 "product_information",
 "company_information",
 "offers",
 "support",
 "general",
]);
const DOCUMENT_STATUSES = new Set(["active", "inactive", "archived"]);


const router = express.Router();
const openai = process.env.OPENAI_API_KEY
 ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
 : null;
const openaiAdmin = process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY
 ? new OpenAI({
   apiKey: process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY,
   organization: process.env.OPENAI_ORG_ID || undefined,
   project: process.env.OPENAI_PROJECT_ID || undefined,
 })
 : null;
const upload = multer({
 storage: multer.memoryStorage(),
 limits: { fileSize: 20 * 1024 * 1024 },
});




function safeStr(v) {
 return String(v ?? "").trim();
}


function clamp(n, min, max) {
 const v = Number(n);
 if (!Number.isFinite(v)) return min;
 return Math.max(min, Math.min(max, v));
}


function toStringArray(value) {
 if (Array.isArray(value)) {
   return value.map((v) => safeStr(v)).filter(Boolean);
 }


 if (value == null) return [];


 return String(value)
   .split(/\r?\n|,/g)
   .map((v) => safeStr(v))
   .filter(Boolean);
}


function cleanUnique(values = [], { lowercase = false } = {}) {
 const out = [];
 const seen = new Set();


 for (const raw of values) {
   const v0 = safeStr(raw);
   if (!v0) continue;
   const value = lowercase ? v0.toLowerCase() : v0;
   const key = value.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   out.push(value);
 }


 return out;
}


function escapeRegex(v = "") {
 return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function actorFromRequest(req) {
 const user = req.session?.user || {};
 return {
   id: safeStr(user.id),
   name: safeStr(user.fullName),
   email: safeStr(user.email),
 };
}


function parseChannels(rawChannels) {
 const channels = cleanUnique(toStringArray(rawChannels), { lowercase: true });
 const valid = channels.filter((c) => KB_CHANNELS.includes(c));
 return valid.length ? valid : ["whatsapp_write_reply"];
}


function normalizeEntryStatus(v, fallback = "active") {
 const value = safeStr(v).toLowerCase();
 return ENTRY_STATUSES.has(value) ? value : fallback;
}


function normalizeEntrySource(v, fallback = "manual") {
 const value = safeStr(v).toLowerCase();
 return ENTRY_SOURCES.has(value) ? value : fallback;
}


function normalizeReviewStatus(v, fallback = "reviewed") {
 const value = safeStr(v).toLowerCase();
 return REVIEW_STATUSES.has(value) ? value : fallback;
}


function normalizeDocumentCategory(v, fallback = "general") {
 const value = safeStr(v).toLowerCase();
 return DOCUMENT_CATEGORIES.has(value) ? value : fallback;
}


function normalizeDocumentStatus(v, fallback = "active") {
 const value = safeStr(v).toLowerCase();
 return DOCUMENT_STATUSES.has(value) ? value : fallback;
}


function normalizeEnumValue(v, validSet, fallback) {
 const value = safeStr(v).toLowerCase();
 return validSet.has(value) ? value : fallback;
}


function normalizeIntent(v, fallback = "support") {
 return normalizeEnumValue(v, ENTRY_INTENTS, fallback);
}


function normalizeStage(v, fallback = "new_user") {
 return normalizeEnumValue(v, ENTRY_STAGES, fallback);
}


function normalizePriority(v, fallback = "medium") {
 return normalizeEnumValue(v, ENTRY_PRIORITIES, fallback);
}


function parseJsonObjectLoose(value) {
 if (value && typeof value === "object" && !Array.isArray(value)) return value;
 if (typeof value !== "string") return {};
 try {
   const parsed = JSON.parse(value);
   return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
 } catch {
   return {};
 }
}


function normalizeNextAction(raw, fallbackType = "none") {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
   return { type: fallbackType, payload: {} };
 }


 const type = normalizeEnumValue(raw.type, NEXT_ACTION_TYPES, fallbackType);
 const payload = parseJsonObjectLoose(raw.payload);


 return { type, payload };
}


function jaccardSimilarityFromTokens(aTokens = [], bTokens = []) {
 if (!aTokens.length || !bTokens.length) return 0;


 const a = new Set(aTokens);
 const b = new Set(bTokens);
 let intersection = 0;


 for (const t of a) {
   if (b.has(t)) intersection += 1;
 }


 if (!intersection) return 0;
 const union = a.size + b.size - intersection;
 return union ? intersection / union : 0;
}


function normalizePhone(v = "") {
 return String(v || "").replace(/\D/g, "").slice(-10);
}


function toSafeNumber(v, fallback = 0) {
 const num = Number(v);
 return Number.isFinite(num) ? num : fallback;
}


function unixStartOfDayUtc(date = new Date()) {
 return Math.floor(Date.UTC(
   date.getUTCFullYear(),
   date.getUTCMonth(),
   date.getUTCDate(),
   0,
   0,
   0,
   0
 ) / 1000);
}


function toDateKeyFromUnix(seconds) {
 const ms = toSafeNumber(seconds, 0) * 1000;
 if (!ms) return "";
 const date = new Date(ms);
 if (Number.isNaN(date.getTime())) return "";
 return date.toISOString().slice(0, 10);
}


async function fetchCreditBalance() {
 const apiKey = safeStr(process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY);
 if (!apiKey) {
   return {
     available: false,
     reason: "missing_key",
   };
 }


 try {
   const resp = await fetch("https://api.openai.com/dashboard/billing/credit_grants", {
     method: "GET",
     headers: {
       Authorization: `Bearer ${apiKey}`,
       "Content-Type": "application/json",
     },
   });


   if (!resp.ok) {
     const responseText = await resp.text().catch(() => "");
     const needsBrowserSession =
       resp.status === 403 && /must be made with a session key/i.test(responseText);


     return {
       available: false,
       reason: needsBrowserSession
         ? "requires_browser_session"
         : `request_failed_${resp.status}`,
     };
   }


   const json = await resp.json();
   const totalGranted = toSafeNumber(json?.total_granted, 0);
   const totalUsed = toSafeNumber(json?.total_used, 0);
   const totalAvailable = toSafeNumber(json?.total_available, 0);


   return {
     available: true,
     currency: "usd",
     totalGranted,
     totalUsed,
     totalAvailable,
     source: "credit_grants",
   };
 } catch {
   return {
     available: false,
     reason: "request_failed",
   };
 }
}


async function findDuplicateCandidate(question, alternateQuestions = []) {
 const query = safeStr(question);
 if (!query) return null;


 const queryTokens = tokenize(normalizeText(query));
 if (!queryTokens.length) return null;


 const entries = await KnowledgeBaseEntry.find({})
   .select("_id canonicalQuestion alternateQuestions")
   .sort({ updatedAt: -1 })
   .limit(300)
   .lean();


 let best = null;
 const newQuestionSet = cleanUnique([query, ...alternateQuestions]);


 for (const entry of entries) {
   const candidates = cleanUnique([
     safeStr(entry?.canonicalQuestion),
     ...(Array.isArray(entry?.alternateQuestions) ? entry.alternateQuestions : []),
   ]);


   let localBest = 0;
   let localText = "";


   for (const existingText of candidates) {
     const existingTokens = tokenize(normalizeText(existingText));
     const score = jaccardSimilarityFromTokens(queryTokens, existingTokens);
     if (score > localBest) {
       localBest = score;
       localText = existingText;
     }
   }


   if (!localBest) continue;


   if (!best || localBest > best.score) {
     best = {
       entryId: String(entry._id),
       canonicalQuestion: safeStr(entry.canonicalQuestion),
       matchedText: localText,
       score: Number(localBest.toFixed(3)),
     };
   }
 }


 if (!best || best.score < 0.72) return null;


 const duplicateWithNewText = newQuestionSet.find(
   (t) => normalizeText(t) === normalizeText(best.matchedText)
 );


 return {
   ...best,
   isNearDuplicate: true,
   exactTextDuplicate: Boolean(duplicateWithNewText),
 };
}


router.get("/entries", requireSession, async (req, res) => {
 try {
   const q = safeStr(req.query.q);
   const status = safeStr(req.query.status || "all").toLowerCase();
   const channel = safeStr(req.query.channel || "all").toLowerCase();
   const domain = safeStr(req.query.domain || "all").toLowerCase();


   const limit = clamp(req.query.limit || 100, 1, 300);
   const page = clamp(req.query.page || 1, 1, 1000);
   const skip = (page - 1) * limit;


   const filter = {};


   if (status !== "all") filter.status = status;
   if (channel !== "all") filter.channels = channel;
   if (domain !== "all") filter.domain = domain;


   if (q) {
     const regex = new RegExp(escapeRegex(q), "i");
     filter.$or = [
       { canonicalQuestion: regex },
       { alternateQuestions: regex },
       { answer: regex },
       { tags: regex },
       { domain: regex },
       { intentCode: regex },
       { intent: regex },
       { stage: regex },
       { priority: regex },
     ];
   }


   const [entries, total] = await Promise.all([
     KnowledgeBaseEntry.find(filter)
       .sort({ updatedAt: -1 })
       .skip(skip)
       .limit(limit)
       .lean(),
     KnowledgeBaseEntry.countDocuments(filter),
   ]);


   return res.json({
     success: true,
     entries,
     pagination: {
       total,
       page,
       limit,
       pages: Math.ceil(total / limit) || 1,
     },
   });
 } catch (e) {
   console.error("knowledge-base entries list error:", e);
   return res.status(500).json({
     message: "Failed to fetch knowledge base entries",
     error: e?.message || String(e),
   });
 }
});


router.post("/ask", requireSession, async (req, res) => {
 try {
   const question = safeStr(req.body?.question);
   const channelRaw = safeStr(req.body?.channel || "whatsapp_write_reply").toLowerCase();
   const channel = KB_CHANNELS.includes(channelRaw)
     ? channelRaw
     : "whatsapp_write_reply";
   const isRepeat = Boolean(req.body?.isRepeat);
   const isEscalated = Boolean(req.body?.isEscalated);


   if (!question) {
     return res.status(400).json({ message: "question is required" });
   }


   let match = await findBestKnowledgeEntry({
     query: question,
     channel,
     includeLowConfidence: true,
   });
   if (match?.score != null && Number(match.score) < MIN_POTENTIAL_MATCH_SCORE) {
     match = null;
   }
   const docMatches = await retrieveRelevantDocumentChunks({
     query: question,
     channel,
     maxChunks: 5,
   }).catch(() => []);


   if (!match?.entry?._id) {
     const entry = null;
     const matchInfo = null;


     let answer = "";
     if (openai) {
       const model = process.env.OPENAI_MODEL || "gpt-5-mini";
       const docsContext = (docMatches || [])
         .map(
           (d, i) =>
             `${i + 1}. ${safeStr(d?.sourceTitle) || "Untitled"}: ${safeStr(d?.text).slice(0, 700)}`
         )
         .join("\n\n");


       const instructions = `
You are an AI support assistant.
Generate a concise, factual answer for the customer question.
Rules:
- Use provided context only; do not invent policy, pricing, or medical claims.
- If context is incomplete, mention uncertainty and ask one clear follow-up.
- Return plain message text only.
`.trim();


       const input = `
Customer question:
${question}


Knowledge base match:
No direct approved match found.


Document context:
${docsContext || "No relevant document snippets found."}
`.trim();


       const response = await openai.responses.create({
         model,
         instructions,
         input,
         max_output_tokens: 280,
       });
       answer = safeStr(response?.output_text);
     }


     if (!answer) {
       answer = "I need a little more detail to answer this accurately. Could you share more context?";
     }


     return res.json({
       success: true,
       found: false,
       confident: false,
       handoff: true,
       question,
       answer,
       entry,
       match: matchInfo,
       escalationReason: "no_match",
       sources: (docMatches || []).map((d) => ({
         title: safeStr(d?.sourceTitle),
         category: safeStr(d?.category),
       })),
     });
   }


   await touchKnowledgeUsage(match.entry._id);
   const score = Number(match?.score || 0);
   const intent = normalizeIntent(match?.entry?.intent, "support");
   const stage = normalizeStage(match?.entry?.stage, "new_user");
   const priority = normalizePriority(match?.entry?.priority, "medium");
   const entryNextAction = normalizeNextAction(match?.entry?.nextAction, "none");


   const lowConfidence = score < MIN_CONFIDENCE_SCORE;
   const complaintIntent = intent === "complaint";
   const handoffByRule = lowConfidence || complaintIntent || isRepeat;
   const shouldHandoff =
     handoffByRule || isEscalated || entryNextAction.type === "handoff";


   const docsContext = (docMatches || [])
     .map(
       (d, i) =>
         `${i + 1}. ${safeStr(d?.sourceTitle) || "Untitled"}: ${safeStr(d?.text).slice(0, 700)}`
     )
     .join("\n\n");


   let answer = safeStr(match.entry.answer);
   const allowConfidentAnswer = !lowConfidence;


   if (allowConfidentAnswer && openai) {
     const model = process.env.OPENAI_MODEL || "gpt-5-mini";
     const instructions = `
You are an AI support assistant.
Rewrite the response for the customer question using approved knowledge and context.
Rules:
- Prioritize approved knowledge-base guidance.
- Use document snippets only to add useful factual detail.
- Do not invent policy, pricing, or medical claims.
- Keep it concise and WhatsApp-friendly.
- Return plain text only.
`.trim();


     const input = `
Customer question:
${question}


Approved knowledge-base answer:
${safeStr(match.entry.answer)}


Document context:
${docsContext || "No relevant snippets."}
`.trim();


     const response = await openai.responses.create({
       model,
       instructions,
       input,
       max_output_tokens: 280,
     });
     const llmAnswer = safeStr(response?.output_text);
     if (llmAnswer) answer = llmAnswer;
   }


   if (!allowConfidentAnswer) {
     answer =
       shouldHandoff
         ? LOW_CONFIDENCE_FALLBACK
         : "I need a bit more context to answer this correctly. Could you share one more detail?";
   }


   const counters = {
     successCount: !shouldHandoff && !isRepeat && !isEscalated ? 1 : 0,
     failureCount: isRepeat || isEscalated ? 1 : 0,
     handoffCount: shouldHandoff ? 1 : 0,
   };
   await incrementKnowledgePerformance(match.entry._id, counters);


   const escalationReasons = [];
   if (lowConfidence) escalationReasons.push("low_confidence");
   if (complaintIntent) escalationReasons.push("complaint_intent");
   if (isRepeat) escalationReasons.push("repeat_query");
   if (isEscalated) escalationReasons.push("escalated");
   if (entryNextAction.type === "handoff") escalationReasons.push("entry_next_action_handoff");


   return res.json({
     success: true,
     found: true,
     confident: allowConfidentAnswer,
     handoff: shouldHandoff,
     question,
     answer,
     entry: {
       _id: match.entry._id,
       canonicalQuestion: safeStr(match.entry.canonicalQuestion),
       domain: safeStr(match.entry.domain || "general"),
       tags: Array.isArray(match.entry.tags) ? match.entry.tags : [],
       status: safeStr(match.entry.status || "active"),
       intent,
       stage,
       priority,
       nextAction: entryNextAction,
       usageCount: Number(match.entry.usageCount || 0) + 1,
       successCount: Number(match.entry.successCount || 0) + counters.successCount,
       failureCount: Number(match.entry.failureCount || 0) + counters.failureCount,
       handoffCount: Number(match.entry.handoffCount || 0) + counters.handoffCount,
     },
     match: {
       score: match.score,
       reason: match.reason,
       matchedText: match.matchedText,
       threshold: match.threshold,
     },
     escalationReason: escalationReasons.join(","),
     sources: (docMatches || []).map((d) => ({
       title: safeStr(d?.sourceTitle),
       category: safeStr(d?.category),
     })),
   });
 } catch (e) {
   console.error("knowledge-base ask error:", e);
   return res.status(500).json({
     message: "Failed to test AI answer against knowledge base",
     error: e?.message || String(e),
   });
 }
});


router.post("/entries", requireSession, async (req, res) => {
 try {
   const canonicalQuestion = safeStr(req.body?.canonicalQuestion);
   const answer = safeStr(req.body?.answer);


   if (!canonicalQuestion) {
     return res.status(400).json({ message: "canonicalQuestion is required" });
   }


   if (!answer) {
     return res.status(400).json({ message: "answer is required" });
   }


   const actor = actorFromRequest(req);
   const alternateQuestions = cleanUnique(toStringArray(req.body?.alternateQuestions));
   const duplicateWarning = await findDuplicateCandidate(
     canonicalQuestion,
     alternateQuestions
   );


   const payload = {
     intentCode: safeStr(req.body?.intentCode) || undefined,
     canonicalQuestion,
     alternateQuestions,
     answer,
     domain: safeStr(req.body?.domain || "general").toLowerCase(),
     tags: cleanUnique(toStringArray(req.body?.tags), { lowercase: true }),
     channels: parseChannels(req.body?.channels),
     status: normalizeEntryStatus(req.body?.status, "active"),
     source: normalizeEntrySource(req.body?.source, "manual"),
     intent: normalizeIntent(req.body?.intent, "support"),
     stage: normalizeStage(req.body?.stage, "new_user"),
     priority: normalizePriority(req.body?.priority, "medium"),
     nextAction: normalizeNextAction(req.body?.nextAction, "none"),
     createdBy: actor,
     updatedBy: actor,
     quality: {
       reviewStatus: normalizeReviewStatus(req.body?.reviewStatus, "reviewed"),
       lastReviewedAt: req.body?.reviewStatus ? new Date() : null,
     },
   };


   const entry = await KnowledgeBaseEntry.create(payload);


   return res.status(201).json({
     success: true,
     entry,
     duplicateWarning: duplicateWarning || null,
   });
 } catch (e) {
   console.error("knowledge-base create error:", e);


   if (e?.code === 11000 && e?.keyPattern?.intentCode) {
     return res.status(409).json({ message: "intentCode already exists" });
   }


   return res.status(500).json({
     message: "Failed to create knowledge base entry",
     error: e?.message || String(e),
   });
 }
});


router.patch("/entries/:id", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const actor = actorFromRequest(req);
   const existing = await KnowledgeBaseEntry.findById(id);
   if (!existing) return res.status(404).json({ message: "Entry not found" });


   const update = {};


   if (req.body?.intentCode !== undefined) update.intentCode = safeStr(req.body.intentCode) || undefined;
   if (req.body?.canonicalQuestion !== undefined) update.canonicalQuestion = safeStr(req.body.canonicalQuestion);
   if (req.body?.answer !== undefined) update.answer = safeStr(req.body.answer);
   if (req.body?.alternateQuestions !== undefined) update.alternateQuestions = cleanUnique(toStringArray(req.body.alternateQuestions));
   if (req.body?.domain !== undefined) update.domain = safeStr(req.body.domain || "general").toLowerCase();
   if (req.body?.tags !== undefined) update.tags = cleanUnique(toStringArray(req.body.tags), { lowercase: true });
   if (req.body?.channels !== undefined) update.channels = parseChannels(req.body.channels);
   if (req.body?.status !== undefined) update.status = normalizeEntryStatus(req.body.status, "active");
   if (req.body?.source !== undefined) update.source = normalizeEntrySource(req.body.source, "manual");
   if (req.body?.intent !== undefined) update.intent = normalizeIntent(req.body.intent, "support");
   if (req.body?.stage !== undefined) update.stage = normalizeStage(req.body.stage, "new_user");
   if (req.body?.priority !== undefined) update.priority = normalizePriority(req.body.priority, "medium");
   if (req.body?.nextAction !== undefined) {
     const fallbackType = normalizeNextAction(existing.nextAction, "none").type;
     update.nextAction = normalizeNextAction(req.body.nextAction, fallbackType);
   }


   if (req.body?.reviewStatus !== undefined) {
     update.quality = {
       reviewStatus: normalizeReviewStatus(req.body.reviewStatus, "reviewed"),
       lastReviewedAt: new Date(),
     };
   }


   let pushUpdate = null;
   if (
     req.body?.answer !== undefined &&
     safeStr(existing.answer) &&
     safeStr(existing.answer) !== safeStr(req.body.answer)
   ) {
     pushUpdate = {
       versions: {
         answer: safeStr(existing.answer),
         updatedAt: new Date(),
         updatedBy: actor.name || actor.email || actor.id || "system",
       },
     };
   }


   update.updatedBy = actor;


   const entry = await KnowledgeBaseEntry.findByIdAndUpdate(
     id,
     { $set: update, ...(pushUpdate ? { $push: pushUpdate } : {}) },
     {
     new: true,
     runValidators: true,
     }
   );


   return res.json({ success: true, entry });
 } catch (e) {
   console.error("knowledge-base update error:", e);


   if (e?.code === 11000 && e?.keyPattern?.intentCode) {
     return res.status(409).json({ message: "intentCode already exists" });
   }


   return res.status(500).json({
     message: "Failed to update knowledge base entry",
     error: e?.message || String(e),
   });
 }
});


router.delete("/entries/:id", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const deleted = await KnowledgeBaseEntry.findByIdAndDelete(id).lean();
   if (!deleted) return res.status(404).json({ message: "Entry not found" });


   return res.json({ success: true, deletedId: id });
 } catch (e) {
   console.error("knowledge-base delete error:", e);
   return res.status(500).json({
     message: "Failed to delete knowledge base entry",
     error: e?.message || String(e),
   });
 }
});


router.get("/gaps", requireSession, async (req, res) => {
 try {
   const q = safeStr(req.query.q);
   const status = safeStr(req.query.status || "open").toLowerCase();
   const channel = safeStr(req.query.channel || "all").toLowerCase();


   const limit = clamp(req.query.limit || 100, 1, 300);
   const page = clamp(req.query.page || 1, 1, 1000);
   const skip = (page - 1) * limit;


   const filter = {};


   if (status !== "all") filter.status = status;
   if (channel !== "all") filter.channel = channel;


   if (q) {
     const regex = new RegExp(escapeRegex(q), "i");
     filter.$or = [
       { questionText: regex },
       { leadName: regex },
       { phone: regex },
       { transcriptSnippet: regex },
     ];
   }


   const [gaps, total] = await Promise.all([
     KnowledgeGap.find(filter)
       .sort({ status: 1, lastSeenAt: -1 })
       .skip(skip)
       .limit(limit)
       .populate("resolution.knowledgeEntryId", "canonicalQuestion status")
       .lean(),
     KnowledgeGap.countDocuments(filter),
   ]);


   return res.json({
     success: true,
     gaps,
     pagination: {
       total,
       page,
       limit,
       pages: Math.ceil(total / limit) || 1,
     },
   });
 } catch (e) {
   console.error("knowledge-gap list error:", e);
   return res.status(500).json({
     message: "Failed to fetch knowledge gaps",
     error: e?.message || String(e),
   });
 }
});


router.patch("/gaps/:id/status", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   const status = safeStr(req.body?.status).toLowerCase();


   if (!id) return res.status(400).json({ message: "id is required" });
   if (!["open", "answered", "ignored"].includes(status)) {
     return res.status(400).json({ message: "Invalid status" });
   }


   const update = {
     status,
   };


   if (status === "ignored") {
     update.resolvedAt = new Date();
     update.resolvedBy = actorFromRequest(req);
   }


   const gap = await KnowledgeGap.findByIdAndUpdate(id, update, {
     new: true,
     runValidators: true,
   }).lean();


   if (!gap) return res.status(404).json({ message: "Gap not found" });


   return res.json({ success: true, gap });
 } catch (e) {
   console.error("knowledge-gap status update error:", e);
   return res.status(500).json({
     message: "Failed to update knowledge gap status",
     error: e?.message || String(e),
   });
 }
});


router.post("/gaps/:id/resolve", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const gap = await KnowledgeGap.findById(id);
   if (!gap) return res.status(404).json({ message: "Gap not found" });


   if (gap.status === "answered" && gap.resolution?.knowledgeEntryId) {
     return res.status(409).json({ message: "Gap is already resolved" });
   }


   const answer = safeStr(req.body?.answer);
   if (!answer) return res.status(400).json({ message: "answer is required" });


   const actor = actorFromRequest(req);


   const canonicalQuestion =
     safeStr(req.body?.canonicalQuestion) || safeStr(gap.questionText);


   const alternateQuestions = cleanUnique([
     ...toStringArray(req.body?.alternateQuestions),
     safeStr(gap.questionText),
   ]);
   const duplicateWarning = await findDuplicateCandidate(
     canonicalQuestion,
     alternateQuestions
   );


   const entry = await KnowledgeBaseEntry.create({
     intentCode: safeStr(req.body?.intentCode) || undefined,
     canonicalQuestion,
     alternateQuestions,
     answer,
     domain: safeStr(req.body?.domain || "general").toLowerCase(),
     tags: cleanUnique(toStringArray(req.body?.tags), { lowercase: true }),
     channels: parseChannels(req.body?.channels || [gap.channel]),
     status: normalizeEntryStatus(req.body?.status, "active"),
     source: "gap_resolution",
     intent: normalizeIntent(req.body?.intent, "support"),
     stage: normalizeStage(req.body?.stage, "new_user"),
     priority: normalizePriority(req.body?.priority, "medium"),
     nextAction: normalizeNextAction(req.body?.nextAction, "none"),
     createdBy: actor,
     updatedBy: actor,
     quality: {
       reviewStatus: normalizeReviewStatus(req.body?.reviewStatus, "reviewed"),
       lastReviewedAt: new Date(),
     },
     metadata: {
       resolvedFromGapId: String(gap._id),
     },
   });


   gap.status = "answered";
   gap.resolvedAt = new Date();
   gap.resolvedBy = actor;
   gap.resolution = {
     knowledgeEntryId: entry._id,
     answer,
     notes: safeStr(req.body?.notes),
   };


   await gap.save();


   return res.status(201).json({
     success: true,
     entry,
     gap,
     duplicateWarning: duplicateWarning || null,
   });
 } catch (e) {
   console.error("knowledge-gap resolve error:", e);


   if (e?.code === 11000 && e?.keyPattern?.intentCode) {
     return res.status(409).json({ message: "intentCode already exists" });
   }


   return res.status(500).json({
     message: "Failed to resolve knowledge gap",
     error: e?.message || String(e),
   });
 }
});


router.get("/documents", requireSession, async (req, res) => {
 try {
   const q = safeStr(req.query.q);
   const status = safeStr(req.query.status || "all").toLowerCase();
   const category = safeStr(req.query.category || "all").toLowerCase();
   const channel = safeStr(req.query.channel || "all").toLowerCase();
   const extractionStatus = safeStr(req.query.extractionStatus || "all").toLowerCase();


   const limit = clamp(req.query.limit || 100, 1, 300);
   const page = clamp(req.query.page || 1, 1, 1000);
   const skip = (page - 1) * limit;


   const filter = {};


   if (status !== "all") filter.status = status;
   if (category !== "all") filter.category = category;
   if (channel !== "all") filter.channels = channel;
   if (extractionStatus !== "all") filter.extractionStatus = extractionStatus;


   if (q) {
     const regex = new RegExp(escapeRegex(q), "i");
     filter.$or = [
       { title: regex },
       { originalFileName: regex },
       { tags: regex },
       { domain: regex },
     ];
   }


   const [documents, total] = await Promise.all([
     KnowledgeDocument.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
     KnowledgeDocument.countDocuments(filter),
   ]);


   return res.json({
     success: true,
     documents,
     pagination: {
       total,
       page,
       limit,
       pages: Math.ceil(total / limit) || 1,
     },
   });
 } catch (e) {
   console.error("knowledge-documents list error:", e);
   return res.status(500).json({
     message: "Failed to fetch knowledge documents",
     error: e?.message || String(e),
   });
 }
});


router.post("/documents/upload", requireSession, upload.single("file"), async (req, res) => {
 try {
   if (!req.file) {
     return res.status(400).json({ message: "file is required" });
   }


   const ext = safeStr(path.extname(req.file.originalname)).toLowerCase();
   const allowedExt = new Set([".pdf", ".docx", ".doc", ".txt", ".md", ".csv", ".tsv"]);
   if (!allowedExt.has(ext)) {
     return res.status(400).json({
       message: "Unsupported file type. Use PDF, DOCX, DOC, TXT, MD, CSV, or TSV.",
     });
   }


   const actor = actorFromRequest(req);


   const document = await processAndStoreKnowledgeDocument({
     file: req.file,
     title: safeStr(req.body?.title) || safeStr(req.file.originalname),
     category: normalizeDocumentCategory(req.body?.category, "general"),
     domain: safeStr(req.body?.domain || "sales").toLowerCase(),
     tags: cleanUnique(toStringArray(req.body?.tags), { lowercase: true }),
     channels: parseChannels(req.body?.channels),
     status: normalizeDocumentStatus(req.body?.status, "active"),
     actor,
   });


   return res.status(201).json({ success: true, document });
 } catch (e) {
   console.error("knowledge-document upload error:", e);
   return res.status(500).json({
     message: "Failed to upload knowledge document",
     error: e?.message || String(e),
   });
 }
});


router.patch("/documents/:id", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const doc = await KnowledgeDocument.findById(id);
   if (!doc) return res.status(404).json({ message: "Document not found" });


   if (req.body?.title !== undefined) doc.title = safeStr(req.body.title);
   if (req.body?.category !== undefined) {
     doc.category = normalizeDocumentCategory(req.body.category, doc.category || "general");
   }
   if (req.body?.domain !== undefined) doc.domain = safeStr(req.body.domain || "sales").toLowerCase();
   if (req.body?.tags !== undefined) {
     doc.tags = cleanUnique(toStringArray(req.body.tags), { lowercase: true });
   }
   if (req.body?.channels !== undefined) {
     doc.channels = parseChannels(req.body.channels);
   }
   if (req.body?.status !== undefined) {
     doc.status = normalizeDocumentStatus(req.body.status, doc.status || "active");
   }


   doc.updatedBy = actorFromRequest(req);
   await doc.save();


   await syncDocumentChunksMetadata(doc._id, {
     title: doc.title,
     category: doc.category,
     domain: doc.domain,
     channels: doc.channels,
     status: doc.status,
   });


   return res.json({ success: true, document: doc });
 } catch (e) {
   console.error("knowledge-document update error:", e);
   return res.status(500).json({
     message: "Failed to update knowledge document",
     error: e?.message || String(e),
   });
 }
});


router.post("/documents/:id/reprocess", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const actor = actorFromRequest(req);
   const document = await reprocessDocument(id, actor);


   return res.json({ success: true, document });
 } catch (e) {
   console.error("knowledge-document reprocess error:", e);
   return res.status(500).json({
     message: "Failed to reprocess document",
     error: e?.message || String(e),
   });
 }
});


router.get("/documents/:id/chunks", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const limit = clamp(req.query.limit || 120, 1, 400);


   const chunks = await KnowledgeDocumentChunk.find({ documentId: id })
     .sort({ chunkIndex: 1 })
     .limit(limit)
     .lean();


   return res.json({ success: true, chunks });
 } catch (e) {
   console.error("knowledge-document chunks list error:", e);
   return res.status(500).json({
     message: "Failed to fetch document chunks",
     error: e?.message || String(e),
   });
 }
});


router.delete("/documents/:id", requireSession, async (req, res) => {
 try {
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const deleted = await deleteKnowledgeDocument(id);
   if (!deleted) return res.status(404).json({ message: "Document not found" });


   return res.json({ success: true, deletedId: id });
 } catch (e) {
   console.error("knowledge-document delete error:", e);
   return res.status(500).json({
     message: "Failed to delete knowledge document",
     error: e?.message || String(e),
   });
 }
});


router.get("/stats", requireSession, async (_req, res) => {
 try {
   const [
     totalEntries,
     activeEntries,
     openGaps,
     answeredGaps,
     ignoredGaps,
     totalDocuments,
     activeDocuments,
     extractionFailedDocuments,
   ] = await Promise.all([
     KnowledgeBaseEntry.countDocuments({}),
     KnowledgeBaseEntry.countDocuments({ status: "active" }),
     KnowledgeGap.countDocuments({ status: "open" }),
     KnowledgeGap.countDocuments({ status: "answered" }),
     KnowledgeGap.countDocuments({ status: "ignored" }),
     KnowledgeDocument.countDocuments({}),
     KnowledgeDocument.countDocuments({ status: "active" }),
     KnowledgeDocument.countDocuments({ extractionStatus: "failed" }),
   ]);


   return res.json({
     success: true,
     stats: {
       totalEntries,
       activeEntries,
       openGaps,
       answeredGaps,
       ignoredGaps,
       totalDocuments,
       activeDocuments,
       extractionFailedDocuments,
     },
   });
 } catch (e) {
   console.error("knowledge-base stats error:", e);
   return res.status(500).json({
     message: "Failed to fetch knowledge base stats",
     error: e?.message || String(e),
   });
 }
});


router.get("/ai-credits", requireSession, async (_req, res) => {
 try {
   if (!openaiAdmin) {
     return res.status(503).json({
       message: "OpenAI key is not configured",
     });
   }


   const warnings = [];
   if (!process.env.OPENAI_ADMIN_KEY) {
     warnings.push(
       "OPENAI_ADMIN_KEY is not set. Some organization usage/cost data may be unavailable."
     );
   }


   const nowSeconds = Math.floor(Date.now() / 1000);
   const todayStart = unixStartOfDayUtc(new Date());
   const start30d = todayStart - (29 * 86400);


   let costsResponse = null;
   let usageResponse = null;


   try {
     costsResponse = await openaiAdmin.get("/organization/costs", {
       query: {
         start_time: start30d,
         end_time: nowSeconds,
         bucket_width: "1d",
         limit: 31,
       },
     });
   } catch (error) {
     warnings.push(
       `Could not fetch organization costs (${safeStr(error?.message) || "unknown error"}).`
     );
   }


   try {
     usageResponse = await openaiAdmin.get("/organization/usage/completions", {
       query: {
         start_time: start30d,
         end_time: nowSeconds,
         bucket_width: "1d",
         limit: 31,
       },
     });
   } catch (error) {
     warnings.push(
       `Could not fetch completions usage (${safeStr(error?.message) || "unknown error"}).`
     );
   }


   const balanceResult = await fetchCreditBalance();
   if (!balanceResult?.available) {
     if (balanceResult?.reason === "requires_browser_session") {
       warnings.push(
         "Credit balance is not available via server API keys. OpenAI exposes that value only in browser session context."
       );
     } else if (balanceResult?.reason === "missing_key") {
       warnings.push("OPENAI_ADMIN_KEY is not set. Credit balance is unavailable.");
     } else {
       warnings.push("Could not fetch credit balance from billing endpoint.");
     }
   }


   const dailyMap = new Map();
   const costBuckets = Array.isArray(costsResponse?.data) ? costsResponse.data : [];
   const usageBuckets = Array.isArray(usageResponse?.data) ? usageResponse.data : [];


   for (const bucket of costBuckets) {
     const dateKey = toDateKeyFromUnix(bucket?.start_time);
     if (!dateKey) continue;
     const results = Array.isArray(bucket?.results) ? bucket.results : [];
     const dayCost = results.reduce(
       (sum, item) => sum + toSafeNumber(item?.amount?.value, 0),
       0
     );
     const existing = dailyMap.get(dateKey) || {
       date: dateKey,
       cost: 0,
       currency: "usd",
       inputTokens: 0,
       outputTokens: 0,
       requests: 0,
     };
     existing.cost = Number((existing.cost + dayCost).toFixed(6));
     dailyMap.set(dateKey, existing);
   }


   for (const bucket of usageBuckets) {
     const dateKey = toDateKeyFromUnix(bucket?.start_time);
     if (!dateKey) continue;
     const results = Array.isArray(bucket?.results) ? bucket.results : [];
     const inputTokens = results.reduce(
       (sum, item) => sum + toSafeNumber(item?.input_tokens, 0),
       0
     );
     const outputTokens = results.reduce(
       (sum, item) => sum + toSafeNumber(item?.output_tokens, 0),
       0
     );
     const requests = results.reduce(
       (sum, item) => sum + toSafeNumber(item?.num_model_requests, 0),
       0
     );


     const existing = dailyMap.get(dateKey) || {
       date: dateKey,
       cost: 0,
       currency: "usd",
       inputTokens: 0,
       outputTokens: 0,
       requests: 0,
     };


     existing.inputTokens += inputTokens;
     existing.outputTokens += outputTokens;
     existing.requests += requests;
     dailyMap.set(dateKey, existing);
   }


   const daily = Array.from(dailyMap.values()).sort((a, b) =>
     safeStr(a.date).localeCompare(safeStr(b.date))
   );


   const todayKey = toDateKeyFromUnix(todayStart);
   const last7DaysKeys = new Set(
     Array.from({ length: 7 }, (_, i) => toDateKeyFromUnix(todayStart - (i * 86400)))
   );


   const totals = daily.reduce(
     (acc, day) => {
       const cost = toSafeNumber(day?.cost, 0);
       const inputTokens = toSafeNumber(day?.inputTokens, 0);
       const outputTokens = toSafeNumber(day?.outputTokens, 0);
       const requests = toSafeNumber(day?.requests, 0);


       acc.last30DaysCost += cost;
       acc.last30DaysInputTokens += inputTokens;
       acc.last30DaysOutputTokens += outputTokens;
       acc.last30DaysRequests += requests;
       if (day.date === todayKey) acc.todayCost += cost;
       if (last7DaysKeys.has(day.date)) acc.last7DaysCost += cost;
       return acc;
     },
     {
       todayCost: 0,
       last7DaysCost: 0,
       last30DaysCost: 0,
       last30DaysInputTokens: 0,
       last30DaysOutputTokens: 0,
       last30DaysRequests: 0,
     }
   );


   return res.json({
     success: true,
     credits: {
       refreshedAt: new Date().toISOString(),
       balance: balanceResult?.available ? balanceResult : {
         currency: "usd",
         totalGranted: null,
         totalUsed: null,
         totalAvailable: null,
         source: balanceResult?.reason || "unavailable",
       },
       spend: {
         currency: "usd",
         today: Number(totals.todayCost.toFixed(6)),
         last7Days: Number(totals.last7DaysCost.toFixed(6)),
         last30Days: Number(totals.last30DaysCost.toFixed(6)),
       },
       usage: {
         inputTokensLast30Days: totals.last30DaysInputTokens,
         outputTokensLast30Days: totals.last30DaysOutputTokens,
         requestsLast30Days: totals.last30DaysRequests,
       },
       daily,
       warnings,
     },
   });
 } catch (e) {
   console.error("knowledge-base ai-credits error:", e);
   return res.status(500).json({
     message: "Failed to fetch AI credits",
     error: e?.message || String(e),
   });
 }
});


module.exports = router;



