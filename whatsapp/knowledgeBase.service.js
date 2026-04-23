const KnowledgeBaseEntry = require("../KnowledgeBase/models/KnowledgeBaseEntry");
const KnowledgeGap = require("../KnowledgeBase/models/KnowledgeGap");


const STOPWORDS = new Set([
 "a",
 "an",
 "the",
 "is",
 "are",
 "am",
 "was",
 "were",
 "be",
 "been",
 "to",
 "for",
 "of",
 "in",
 "on",
 "at",
 "by",
 "with",
 "and",
 "or",
 "but",
 "if",
 "then",
 "this",
 "that",
 "it",
 "its",
 "my",
 "your",
 "our",
 "you",
 "me",
 "we",
 "i",
 "can",
 "could",
 "please",
 "pls",
 "hi",
 "hello",
 "hey",
 "haan",
 "haanji",
 "ji",
 "kya",
 "ka",
 "ki",
 "ke",
 "ko",
]);


function safeStr(v) {
 return String(v ?? "").trim();
}


function normalizeText(v = "") {
 return safeStr(v)
   .toLowerCase()
   .replace(/[^a-z0-9\s]/g, " ")
   .replace(/\s+/g, " ")
   .trim();
}


function tokenize(v = "") {
 const norm = normalizeText(v);
 if (!norm) return [];


 return norm
   .split(" ")
   .map((t) => t.trim())
   .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}


function dedupeList(values = []) {
 const out = [];
 const seen = new Set();
 for (const v of values) {
   const s = safeStr(v);
   if (!s) continue;
   const key = s.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   out.push(s);
 }
 return out;
}


function tokenScore(queryTokens = [], candidateTokens = []) {
 if (!queryTokens.length || !candidateTokens.length) return 0;
 const querySet = new Set(queryTokens);
 const candidateSet = new Set(candidateTokens);


 let intersection = 0;
 for (const t of querySet) {
   if (candidateSet.has(t)) intersection += 1;
 }


 if (!intersection) return 0;
 const coverage = intersection / querySet.size;
 const precision = intersection / candidateSet.size;


 return coverage * 0.7 + precision * 0.3;
}


function computeEntryMatch(entry, queryNorm, queryTokens) {
 const canonical = safeStr(entry?.canonicalQuestion);
 const alternates = Array.isArray(entry?.alternateQuestions)
   ? entry.alternateQuestions
   : [];
 const tags = Array.isArray(entry?.tags) ? entry.tags : [];


 const candidates = dedupeList([canonical, ...alternates, ...tags]);


 let best = {
   score: 0,
   matchedText: "",
   reason: "",
 };


 for (const text of candidates) {
   const candidateNorm = normalizeText(text);
   if (!candidateNorm) continue;


   const candidateTokens = tokenize(candidateNorm);
   const baseScore = tokenScore(queryTokens, candidateTokens);


   let score = baseScore;
   if (queryNorm === candidateNorm) score += 0.5;
   if (queryNorm && candidateNorm && queryNorm.includes(candidateNorm) && candidateNorm.length >= 10) score += 0.3;
   if (queryNorm && candidateNorm && candidateNorm.includes(queryNorm) && queryNorm.length >= 10) score += 0.2;


   score = Math.min(1, score);


   if (score > best.score) {
     best = {
       score,
       matchedText: text,
       reason:
         queryNorm === candidateNorm
           ? "exact"
           : baseScore >= 0.35
           ? "token_overlap"
           : "partial",
     };
   }
 }


 return best;
}


function confidenceThreshold(queryTokens = []) {
 if (queryTokens.length <= 2) return 0.62;
 if (queryTokens.length <= 4) return 0.5;
 return 0.4;
}


async function findBestKnowledgeEntry({
 query,
 channel = "whatsapp_write_reply",
 includeLowConfidence = false,
}) {
 const queryText = safeStr(query);
 const queryNorm = normalizeText(queryText);
 const queryTokens = tokenize(queryNorm);


 if (!queryNorm || queryTokens.length < 2) {
   return null;
 }


 const entries = await KnowledgeBaseEntry.find({
   status: "active",
   channels: channel,
 })
   .select(
     "canonicalQuestion alternateQuestions answer tags domain channels status intent stage priority nextAction usage usageCount successCount failureCount handoffCount"
   )
   .lean();


 if (!entries.length) return null;


 let best = null;


 for (const entry of entries) {
   const result = computeEntryMatch(entry, queryNorm, queryTokens);
   if (!best || result.score > best.score) {
     best = {
       entry,
       score: result.score,
       matchedText: result.matchedText,
       reason: result.reason,
     };
   }
 }


 if (!best) return null;


 const threshold = confidenceThreshold(queryTokens);
 if (!includeLowConfidence && best.score < threshold) return null;


 return {
   entry: best.entry,
   score: Number(best.score.toFixed(3)),
   matchedText: best.matchedText,
   reason: best.reason,
   threshold,
   meetsThreshold: best.score >= threshold,
 };
}


async function touchKnowledgeUsage(entryId) {
 if (!entryId) return;


 await KnowledgeBaseEntry.updateOne(
   { _id: entryId },
   {
     $inc: { "usage.helpWriteHits": 1, usageCount: 1 },
     $set: { "usage.lastUsedAt": new Date() },
   }
 );
}


async function incrementKnowledgePerformance(entryId, counters = {}) {
 if (!entryId) return;


 const inc = {};
 if (Number(counters.successCount) > 0) inc.successCount = Number(counters.successCount);
 if (Number(counters.failureCount) > 0) inc.failureCount = Number(counters.failureCount);
 if (Number(counters.handoffCount) > 0) inc.handoffCount = Number(counters.handoffCount);
 if (!Object.keys(inc).length) return;


 await KnowledgeBaseEntry.updateOne({ _id: entryId }, { $inc: inc });
}


async function logKnowledgeGap({
 questionText,
 channel = "whatsapp_write_reply",
 phone = "",
 leadName = "",
 transcriptSnippet = "",
 metadata = {},
}) {
 const question = safeStr(questionText);
 const normalized = normalizeText(question);
 if (!normalized) return null;


 const now = new Date();


 const existing = await KnowledgeGap.findOne({
   normalizedQuestion: normalized,
   channel,
   status: "open",
 });


 if (existing) {
   existing.lastSeenAt = now;
   existing.occurrenceCount = Number(existing.occurrenceCount || 1) + 1;
   if (phone) existing.phone = phone;
   if (leadName) existing.leadName = leadName;
   if (transcriptSnippet) existing.transcriptSnippet = transcriptSnippet;
   existing.metadata = {
     ...(existing.metadata || {}),
     ...(metadata || {}),
   };
   await existing.save();
   return existing;
 }


 const created = await KnowledgeGap.create({
   questionText: question,
   normalizedQuestion: normalized,
   channel,
   phone,
   leadName,
   transcriptSnippet,
   occurrenceCount: 1,
   firstSeenAt: now,
   lastSeenAt: now,
   metadata: metadata || {},
 });


 return created;
}


module.exports = {
 findBestKnowledgeEntry,
 touchKnowledgeUsage,
 incrementKnowledgePerformance,
 logKnowledgeGap,
 normalizeText,
 tokenize,
};



