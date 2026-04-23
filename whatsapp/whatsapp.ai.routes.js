// routes/whatsapp.ai.routes.js
const express = require("express");
const OpenAI = require("openai");
const requireSession = require("../middleware/requireSession");


const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");
const WhatsAppAIPromptSettings = require("../models/WhatsAppAIPromptSettings");
const {
 findBestKnowledgeEntry,
 touchKnowledgeUsage,
 logKnowledgeGap,
} = require("./knowledgeBase.service");
const {
 retrieveRelevantDocumentChunks,
} = require("./knowledgeDocuments.service");
const {
 getCustomerContextByPhone,
} = require("./customerContext.service");


const router = express.Router();


const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);


const normalizeWaId = (v = "") => {
 const d = digitsOnly(v);
 if (d.length === 10) return `91${d}`;
 return d;
};


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_HELP_ME_WRITE_INSTRUCTIONS = `
You help a support agent write a WhatsApp message.


Rules:
- Output ONLY the message text (no quotes, no headings).
- Keep it WhatsApp-friendly and short (1-5 lines).
- Match tone: {{tone}}.
- Ongoing chat state: {{conversation_in_progress}}. If YES, do NOT start with greeting words like "Hi", "Hello", "Hey".
- If this is clearly a fresh chat, greeting is allowed.
- Session active state: {{session_active}}.
- If session is expired: write a polite message that asks to continue the conversation / get consent, without mentioning "template".
- Never invent order details, medical claims, discounts, or policies not present in context.
- Use customer context (lead/order history) if provided; do not contradict known order status.
- If knowledge-base guidance is present, prioritize it and stay consistent with it.
- If document context has relevant facts, use those facts as source of truth.
- For pricing/cost questions, prefer exact figures from document snippets (e.g., Rs, MRP, plan variants).
- If knowledge base and document context conflict, prefer the latest business policy tone and ask for confirmation if unsure.
- Never claim "not available" or "not found" unless the provided context explicitly says that.
- If missing info is required, ask 1-2 clarifying questions inside the message.
`.trim();


function safeStr(x) {
 return String(x ?? "").trim();
}


function clamp(n, min, max) {
 const v = Number(n);
 if (!Number.isFinite(v)) return min;
 return Math.max(min, Math.min(max, v));
}


function actorFromRequest(req) {
 const user = req.session?.user || {};
 return {
   id: safeStr(user.id),
   name: safeStr(user.fullName || user.name),
   email: safeStr(user.email),
 };
}


function renderPromptTemplate(template = "", vars = {}) {
 const text = safeStr(template);
 if (!text) return "";
 return text.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) =>
   safeStr(vars[key]) || ""
 );
}


function createPromptVersionId() {
 return `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}


function asPromptVersionPublic(version = {}) {
 return {
   versionId: safeStr(version.versionId),
   label: safeStr(version.label),
   source: safeStr(version.source || "manual"),
   createdAt: version.createdAt || null,
   createdBy: {
     id: safeStr(version?.createdBy?.id),
     name: safeStr(version?.createdBy?.name),
     email: safeStr(version?.createdBy?.email),
   },
   helpMeWriteInstructions: safeStr(version.helpMeWriteInstructions),
   isActive: false,
 };
}


function toPromptList(settings) {
 const activeVersionId = safeStr(settings?.activeVersionId);
 return (Array.isArray(settings?.versions) ? settings.versions : [])
   .map((v) => {
     const out = asPromptVersionPublic(v);
     return {
       id: out.versionId,
       name: out.label || "Untitled Prompt",
       helpMeWriteInstructions: out.helpMeWriteInstructions,
       createdAt: out.createdAt,
       createdBy: out.createdBy,
       isActive: safeStr(out.versionId) === activeVersionId,
     };
   })
   .sort(
     (a, b) =>
       new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
   );
}


function attachPromptVersionBootstrap(doc, actor = {}) {
 if (!doc) return null;


 if (!Array.isArray(doc.versions)) doc.versions = [];


 if (!doc.versions.length) {
   const fallbackInstructions =
     safeStr(doc.helpMeWriteInstructions) || DEFAULT_HELP_ME_WRITE_INSTRUCTIONS;
   const versionId = createPromptVersionId();
   doc.versions.push({
     versionId,
     label: "Initial",
     helpMeWriteInstructions: fallbackInstructions,
     createdBy: actor,
     source: "bootstrap",
     createdAt: new Date(),
   });
   doc.activeVersionId = versionId;
   doc.helpMeWriteInstructions = fallbackInstructions;
   return doc;
 }


 const activeVersion = doc.versions.find(
   (v) => safeStr(v.versionId) === safeStr(doc.activeVersionId)
 );


 if (!activeVersion) {
   doc.activeVersionId = safeStr(doc.versions[doc.versions.length - 1]?.versionId);
 }


 const resolvedActive = doc.versions.find(
   (v) => safeStr(v.versionId) === safeStr(doc.activeVersionId)
 );


 if (resolvedActive && safeStr(resolvedActive.helpMeWriteInstructions)) {
   doc.helpMeWriteInstructions = safeStr(resolvedActive.helpMeWriteInstructions);
 }


 return doc;
}


async function getOrCreateAIPromptSettings() {
 let doc = await WhatsAppAIPromptSettings.findOne({ singletonKey: "default" });
 if (!doc) {
   doc = await WhatsAppAIPromptSettings.create({
     singletonKey: "default",
     helpMeWriteInstructions: DEFAULT_HELP_ME_WRITE_INSTRUCTIONS,
   });
   return doc;
 }


 if (!safeStr(doc.helpMeWriteInstructions)) {
   doc.helpMeWriteInstructions = DEFAULT_HELP_ME_WRITE_INSTRUCTIONS;
 }


 attachPromptVersionBootstrap(doc, {
   id: "",
   name: "system",
   email: "",
 });
 if (doc.isModified()) {
   await doc.save();
 }


 return doc;
}


// Don’t leak raw media URLs into the prompt. Keep only a tag.
function buildConversationTranscript(msgs = []) {
 return (msgs || [])
   .map((m) => {
     const dir =
       String(m.direction || "").toUpperCase() === "OUTBOUND" ? "AGENT" : "CUSTOMER";


     const t = safeStr(m.text);


     const hasMedia =
       Boolean(m?.media?.id) ||
       Boolean(m?.media?.url) ||
       Boolean(m?.media?.filename);


     const mediaTag = hasMedia ? ` [MEDIA:${m.type || "file"}]` : "";


     return `${dir}: ${t || ""}${mediaTag}`.trim();
   })
   .filter(Boolean)
   .join("\n");
}


function isInboundMessage(msg) {
 return String(msg?.direction || "").toUpperCase() !== "OUTBOUND";
}


function stripAutoGreeting(text = "") {
 const value = safeStr(text);
 if (!value) return "";


 // Remove common opener-only greetings when the chat is already in progress.
 return value
   .replace(
     /^(hi|hello|hey|hii|helo|dear customer|dear)\s*([!,.:-]\s*)?/i,
     ""
   )
   .trim();
}


function buildRetrievalQuery({ candidateQuestion = "", messages = [] }) {
 const question = safeStr(candidateQuestion);
 const inboundTexts = (messages || [])
   .filter((m) => isInboundMessage(m) && safeStr(m?.text))
   .map((m) => safeStr(m.text));


 if (!question && !inboundTexts.length) return "";
 if (!inboundTexts.length) return question;


 const unique = [];
 const seen = new Set();
 for (const text of [question, ...inboundTexts]) {
   const value = safeStr(text);
   if (!value) continue;
   const key = value.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   unique.push(value);
 }


 // Keep latest customer question + up to 2 previous inbound context lines.
 return unique.slice(0, 3).join(" | ").slice(0, 700);
}


async function callOpenAI({ instructions, input, maxOutputTokens = 220 }) {
 const model = process.env.OPENAI_MODEL || "gpt-5-mini";


 const resp = await openai.responses.create({
   model,
   instructions,
   input,
   max_output_tokens: maxOutputTokens,
 });


 return safeStr(resp.output_text);
}


router.get("/ai-prompt-settings", requireSession, async (req, res) => {
 try {
   const settings = await getOrCreateAIPromptSettings();
   const activeVersionId = safeStr(settings.activeVersionId);
   const versions = (Array.isArray(settings.versions) ? settings.versions : [])
     .map((v) => {
       const out = asPromptVersionPublic(v);
       out.isActive = safeStr(out.versionId) === activeVersionId;
       return out;
     })
     .sort(
       (a, b) =>
         new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
     );


   const prompts = toPromptList(settings);


   return res.json({
     success: true,
     settings: {
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       updatedBy: {
         id: safeStr(settings?.updatedBy?.id),
         name: safeStr(settings?.updatedBy?.name),
         email: safeStr(settings?.updatedBy?.email),
       },
       activeVersionId,
       versions,
       prompts,
     },
     defaults: {
       helpMeWriteInstructions: DEFAULT_HELP_ME_WRITE_INSTRUCTIONS,
     },
   });
 } catch (e) {
   console.error("ai prompt settings get error:", e);
   return res.status(500).json({
     message: "Failed to fetch AI prompt settings",
     error: e?.message || String(e),
   });
 }
});


router.post("/ai-prompt-settings/prompts", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const name = safeStr(req.body?.name).slice(0, 120);
   const helpMeWriteInstructions = safeStr(req.body?.helpMeWriteInstructions);
   const activate = req.body?.activate !== false;


   if (!name) {
     return res.status(400).json({ message: "name is required" });
   }
   if (!helpMeWriteInstructions) {
     return res.status(400).json({ message: "helpMeWriteInstructions is required" });
   }
   if (helpMeWriteInstructions.length > 12000) {
     return res.status(400).json({ message: "helpMeWriteInstructions is too long" });
   }


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);


   const versionId = createPromptVersionId();
   settings.versions.push({
     versionId,
     label: name,
     helpMeWriteInstructions,
     createdBy: actor,
     source: "manual",
     createdAt: new Date(),
   });


   if (activate) {
     settings.activeVersionId = versionId;
     settings.helpMeWriteInstructions = helpMeWriteInstructions;
     settings.updatedBy = actor;
   }


   await settings.save();


   const prompts = toPromptList(settings);
   return res.status(201).json({
     success: true,
     prompt: prompts.find((p) => safeStr(p.id) === versionId) || null,
     settings: {
       activeVersionId: safeStr(settings.activeVersionId),
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt create error:", e);
   return res.status(500).json({
     message: "Failed to create prompt",
     error: e?.message || String(e),
   });
 }
});


router.patch("/ai-prompt-settings/prompts/:id", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const id = safeStr(req.params?.id);
   const name = safeStr(req.body?.name).slice(0, 120);
   const helpMeWriteInstructions = safeStr(req.body?.helpMeWriteInstructions);


   if (!id) return res.status(400).json({ message: "id is required" });
   if (!name) return res.status(400).json({ message: "name is required" });
   if (!helpMeWriteInstructions) {
     return res.status(400).json({ message: "helpMeWriteInstructions is required" });
   }
   if (helpMeWriteInstructions.length > 12000) {
     return res.status(400).json({ message: "helpMeWriteInstructions is too long" });
   }


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);
   const prompt = (settings.versions || []).find((v) => safeStr(v.versionId) === id);
   if (!prompt) {
     return res.status(404).json({ message: "Prompt not found" });
   }


   prompt.label = name;
   prompt.helpMeWriteInstructions = helpMeWriteInstructions;


   if (safeStr(settings.activeVersionId) === id) {
     settings.helpMeWriteInstructions = helpMeWriteInstructions;
     settings.updatedBy = actor;
   }
   await settings.save();


   const prompts = toPromptList(settings);
   return res.json({
     success: true,
     prompt: prompts.find((p) => safeStr(p.id) === id) || null,
     settings: {
       activeVersionId: safeStr(settings.activeVersionId),
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt update error:", e);
   return res.status(500).json({
     message: "Failed to update prompt",
     error: e?.message || String(e),
   });
 }
});


router.post("/ai-prompt-settings/prompts/:id/activate", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);
   const prompt = (settings.versions || []).find((v) => safeStr(v.versionId) === id);
   if (!prompt) {
     return res.status(404).json({ message: "Prompt not found" });
   }


   settings.activeVersionId = id;
   settings.helpMeWriteInstructions = safeStr(prompt.helpMeWriteInstructions);
   settings.updatedBy = actor;
   await settings.save();


   const prompts = toPromptList(settings);
   return res.json({
     success: true,
     settings: {
       activeVersionId: safeStr(settings.activeVersionId),
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt activate error:", e);
   return res.status(500).json({
     message: "Failed to activate prompt",
     error: e?.message || String(e),
   });
 }
});


router.post("/ai-prompt-settings/prompts/:id/copy", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);
   const prompt = (settings.versions || []).find((v) => safeStr(v.versionId) === id);
   if (!prompt) return res.status(404).json({ message: "Prompt not found" });


   const copiedId = createPromptVersionId();
   const copiedNameBase = safeStr(prompt.label) || "Untitled Prompt";
   const copiedName = `Copy of ${copiedNameBase}`.slice(0, 120);
   settings.versions.push({
     versionId: copiedId,
     label: copiedName,
     helpMeWriteInstructions: safeStr(prompt.helpMeWriteInstructions),
     createdBy: actor,
     source: "manual",
     createdAt: new Date(),
   });
   await settings.save();


   const prompts = toPromptList(settings);
   return res.status(201).json({
     success: true,
     prompt: prompts.find((p) => safeStr(p.id) === copiedId) || null,
     settings: {
       activeVersionId: safeStr(settings.activeVersionId),
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt copy error:", e);
   return res.status(500).json({
     message: "Failed to copy prompt",
     error: e?.message || String(e),
   });
 }
});


router.delete("/ai-prompt-settings/prompts/:id", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const id = safeStr(req.params?.id);
   if (!id) return res.status(400).json({ message: "id is required" });


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);


   const existing = Array.isArray(settings.versions) ? settings.versions : [];
   const nextVersions = existing.filter((v) => safeStr(v.versionId) !== id);
   if (nextVersions.length === existing.length) {
     return res.status(404).json({ message: "Prompt not found" });
   }
   if (!nextVersions.length) {
     return res.status(400).json({ message: "Cannot delete the last prompt" });
   }


   settings.versions = nextVersions;


   if (safeStr(settings.activeVersionId) === id) {
     const fallback = settings.versions[settings.versions.length - 1];
     settings.activeVersionId = safeStr(fallback?.versionId);
     settings.helpMeWriteInstructions = safeStr(
       fallback?.helpMeWriteInstructions || DEFAULT_HELP_ME_WRITE_INSTRUCTIONS
     );
     settings.updatedBy = actor;
   }


   await settings.save();
   const prompts = toPromptList(settings);
   return res.json({
     success: true,
     settings: {
       activeVersionId: safeStr(settings.activeVersionId),
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt delete error:", e);
   return res.status(500).json({
     message: "Failed to delete prompt",
     error: e?.message || String(e),
   });
 }
});


router.patch("/ai-prompt-settings", requireSession, async (req, res) => {
 try {
   const actor = actorFromRequest(req);
   const switchActiveVersionId = safeStr(req.body?.switchActiveVersionId);
   const versionLabel = safeStr(req.body?.versionLabel).slice(0, 120);
   const body = safeStr(req.body?.helpMeWriteInstructions);
   const resetToDefault = Boolean(req.body?.resetToDefault);


   const settings = await getOrCreateAIPromptSettings();
   attachPromptVersionBootstrap(settings, actor);


   if (switchActiveVersionId) {
     const nextActiveVersion = (settings.versions || []).find(
       (v) => safeStr(v.versionId) === switchActiveVersionId
     );
     if (!nextActiveVersion) {
       return res.status(404).json({
         message: "Requested version was not found",
       });
     }


     settings.activeVersionId = safeStr(nextActiveVersion.versionId);
     settings.helpMeWriteInstructions = safeStr(
       nextActiveVersion.helpMeWriteInstructions
     );
     settings.updatedBy = actor;
     await settings.save();


     const activeVersionId = safeStr(settings.activeVersionId);
     const versions = (Array.isArray(settings.versions) ? settings.versions : [])
       .map((v) => {
         const out = asPromptVersionPublic(v);
         out.isActive = safeStr(out.versionId) === activeVersionId;
         return out;
       })
       .sort(
         (a, b) =>
           new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
       );
     const prompts = toPromptList(settings);


     return res.json({
       success: true,
       settings: {
         helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
         updatedAt: settings.updatedAt,
         updatedBy: {
           id: safeStr(settings?.updatedBy?.id),
           name: safeStr(settings?.updatedBy?.name),
           email: safeStr(settings?.updatedBy?.email),
         },
         activeVersionId,
         versions,
         prompts,
       },
     });
   }


   const nextValue = resetToDefault
     ? DEFAULT_HELP_ME_WRITE_INSTRUCTIONS
     : body;


   if (!nextValue) {
     return res.status(400).json({
       message: "helpMeWriteInstructions is required",
     });
   }


   if (nextValue.length > 12000) {
     return res.status(400).json({
       message: "helpMeWriteInstructions is too long",
     });
   }


   const newVersionId = createPromptVersionId();
   settings.versions.push({
     versionId: newVersionId,
     label:
       versionLabel ||
       (resetToDefault ? "Reset to default" : `Manual update ${new Date().toISOString()}`),
     helpMeWriteInstructions: nextValue,
     createdBy: actor,
     source: resetToDefault ? "reset_default" : "manual",
     createdAt: new Date(),
   });
   settings.activeVersionId = newVersionId;
   settings.helpMeWriteInstructions = nextValue;
   settings.updatedBy = actor;
   await settings.save();


   const activeVersionId = safeStr(settings.activeVersionId);
   const versions = (Array.isArray(settings.versions) ? settings.versions : [])
     .map((v) => {
       const out = asPromptVersionPublic(v);
       out.isActive = safeStr(out.versionId) === activeVersionId;
       return out;
     })
     .sort(
       (a, b) =>
         new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
     );
   const prompts = toPromptList(settings);


   return res.json({
     success: true,
     settings: {
       helpMeWriteInstructions: safeStr(settings.helpMeWriteInstructions),
       updatedAt: settings.updatedAt,
       updatedBy: {
         id: safeStr(settings?.updatedBy?.id),
         name: safeStr(settings?.updatedBy?.name),
         email: safeStr(settings?.updatedBy?.email),
       },
       activeVersionId,
       versions,
       prompts,
     },
   });
 } catch (e) {
   console.error("ai prompt settings update error:", e);
   return res.status(500).json({
     message: "Failed to update AI prompt settings",
     error: e?.message || String(e),
   });
 }
});


/**
* POST /api/whatsapp/help-me-write
* body: { phone, leadName?, agentName?, goal?, tone?, maxMessages? }
*
* returns: { success: true, suggestion: "..." }
*/
router.post("/help-me-write", async (req, res) => {
 try {
   const phoneRaw = req.body?.phone;
   const phone10 = last10(phoneRaw);
   if (!phone10) return res.status(400).json({ message: "phone required" });


   const waId = normalizeWaId(phone10);
   const l10 = waId.slice(-10);


   const leadName = safeStr(req.body?.leadName).slice(0, 80);
   const agentName = safeStr(req.body?.agentName).slice(0, 80);
   const goal =
     safeStr(req.body?.goal).slice(0, 600) ||
     "Write the next best WhatsApp reply to the customer.";
   const tone =
     safeStr(req.body?.tone).slice(0, 160) ||
     "friendly, professional, concise, Hinglish allowed";


   const maxMessages = clamp(req.body?.maxMessages || 30, 5, 80);


   const msgs = await WhatsAppMessage.find({
     $or: [
       { from: waId },
       { to: waId },
       { from: new RegExp(`${l10}$`) },
       { to: new RegExp(`${l10}$`) },
     ],
   })
     .sort({ timestamp: -1 })
     .limit(maxMessages)
     .lean();


   const convo = await WhatsAppConversation.findOne({
     phone: new RegExp(`${l10}$`),
   }).lean();


   const transcript = buildConversationTranscript((msgs || []).reverse());
   const latestInbound = (msgs || []).find((m) => isInboundMessage(m) && Boolean(safeStr(m?.text)));


   const candidateQuestion = safeStr(
     req.body?.customerQuestion || latestInbound?.text
   );
   const customerContext = await getCustomerContextByPhone(phone10).catch((err) => {
     console.error("customer context lookup error:", err);
     return {
       found: false,
       phone10,
       lead: null,
       customer: null,
       orders: [],
       contextText: "Customer context unavailable.",
     };
   });


   const retrievalQuery = buildRetrievalQuery({
     candidateQuestion,
     messages: msgs || [],
   });


   let knowledgeMatch = null;
   let docMatches = [];
   if (candidateQuestion || retrievalQuery) {
     try {
       knowledgeMatch = await findBestKnowledgeEntry({
         query: candidateQuestion,
         channel: "whatsapp_write_reply",
       });


       docMatches = await retrieveRelevantDocumentChunks({
         query: retrievalQuery || candidateQuestion,
         channel: "whatsapp_write_reply",
         maxChunks: 6,
       });


       if (knowledgeMatch?.entry?._id) {
         await touchKnowledgeUsage(knowledgeMatch.entry._id);
       }


       if (!knowledgeMatch?.entry?._id && !(docMatches || []).length) {
         await logKnowledgeGap({
           questionText: candidateQuestion,
           channel: "whatsapp_write_reply",
           phone: waId,
           leadName: leadName || "",
           transcriptSnippet: String(transcript || "").slice(-1800),
           metadata: { source: "help-me-write" },
         });
       }
     } catch (kbErr) {
       console.error("knowledge lookup error:", kbErr);
     }
   }


   const sessionActive =
     convo?.windowExpiresAt &&
     new Date(convo.windowExpiresAt).getTime() > Date.now();
   const hasPriorAgentMessages = (msgs || []).some(
     (m) => String(m?.direction || "").toUpperCase() === "OUTBOUND"
   );
   const conversationInProgress = Boolean(hasPriorAgentMessages || (msgs || []).length > 2);


   const knowledgeContext = knowledgeMatch?.entry
     ? `
Knowledge base match:
- Customer question matched: ${candidateQuestion}
- Approved answer guidance: ${safeStr(knowledgeMatch.entry.answer)}
- Domain: ${safeStr(knowledgeMatch.entry.domain) || "general"}
- Match confidence: ${knowledgeMatch.score}
`.trim()
     : "Knowledge base match: no direct approved entry found for this question.";


   const documentsContext =
     (docMatches || []).length > 0
       ? `
Document context (sales-agent brain):
${docMatches
 .map(
   (d, i) =>
     `${i + 1}. Source: ${d.sourceTitle || "Untitled"} | Category: ${d.category || "general"} | Domain: ${d.domain || "sales"}\nSnippet: ${safeStr(d.text).slice(0, 900)}`
 )
 .join("\n\n")}
`.trim()
       : "Document context: no relevant document snippets found.";


   const settings = await getOrCreateAIPromptSettings();
   const instructions = renderPromptTemplate(
     safeStr(settings.helpMeWriteInstructions) || DEFAULT_HELP_ME_WRITE_INSTRUCTIONS,
     {
       tone,
       session_active: sessionActive ? "YES" : "NO",
       conversation_in_progress: conversationInProgress ? "YES" : "NO",
     }
   );


   const input = `
Context:
- Customer: ${leadName || phone10}
- Agent: ${agentName || "Support Agent"}
- Session active: ${sessionActive ? "YES" : "NO"}
- Ongoing chat: ${conversationInProgress ? "YES" : "NO"}


Goal:
${goal}


Conversation (most recent at bottom):
${transcript || "(no prior messages found)"}


Customer context (from CRM/order systems):
${safeStr(customerContext?.contextText) || "No customer profile or order history found for this number."}


${knowledgeContext}
${documentsContext}


Write the next message now.
`.trim();


   const suggestion = await callOpenAI({
     instructions,
     input,
     maxOutputTokens: 220,
   });


   if (!suggestion) {
     return res.status(500).json({ message: "AI did not return text" });
   }


   const finalSuggestion = conversationInProgress
     ? stripAutoGreeting(suggestion)
     : suggestion;


   return res.json({
     success: true,
     suggestion: finalSuggestion || suggestion,
     knowledgeBase: knowledgeMatch?.entry
       ? {
           id: knowledgeMatch.entry._id,
           matchedText: knowledgeMatch.matchedText,
           confidence: knowledgeMatch.score,
           domain: knowledgeMatch.entry.domain,
         }
       : null,
     customerContext: {
       found: Boolean(customerContext?.found),
       phone: customerContext?.phone10 || phone10,
       lead: customerContext?.lead || null,
       customer: customerContext?.customer || null,
       orders: Array.isArray(customerContext?.orders) ? customerContext.orders : [],
     },
     documentSources: (docMatches || []).map((d) => ({
       title: d.sourceTitle,
       category: d.category,
       domain: d.domain,
     })),
   });
 } catch (e) {
   console.error("help-me-write error:", e);
   return res.status(500).json({
     message: "Help me write failed",
     error: e?.message || String(e),
   });
 }
});


/**
* POST /api/whatsapp/rephrase
* body: { text, style }
* style: "simple" | "professional" | "friendly" | "empathetic"
*
* returns: { success: true, result: "..." }
*/
router.post("/rephrase", async (req, res) => {
 try {
   const text = safeStr(req.body?.text);
   const styleRaw = safeStr(req.body?.style).toLowerCase();


   if (!text) return res.status(400).json({ message: "text required" });


   if (text.length > 2000) {
     return res.status(400).json({ message: "text too long (max 2000 chars)" });
   }


   const allowed = ["simple", "professional", "friendly", "empathetic"];
   const style = allowed.includes(styleRaw) ? styleRaw : "professional";


   const styleGuide = {
     simple: "Very simple, clear, easy words. Short sentences. No extra fluff.",
     professional: "Polite, professional, crisp. No slang. Clear next step/question if needed.",
     friendly: "Warm and friendly, natural tone, Hinglish allowed if suitable. Keep concise.",
     empathetic: "Show empathy and understanding first, then solution/next step. Calm and supportive.",
   }[style];


   const instructions = `
You rewrite a WhatsApp message for a support agent.


Rules:
- Output ONLY the rewritten message text.
- Keep meaning same. Do NOT add new claims/details.
- Keep it WhatsApp-friendly (1-6 lines).
- Style: ${style} — ${styleGuide}
`.trim();


   const input = `
Original message:
${text}


Rewrite now.
`.trim();


   const result = await callOpenAI({
     instructions,
     input,
     maxOutputTokens: 200,
   });


   if (!result) {
     return res.status(500).json({ message: "AI did not return text" });
   }


   return res.json({ success: true, result });
 } catch (e) {
   console.error("rephrase error:", e);
   return res.status(500).json({
     message: "Rephrase failed",
     error: e?.message || String(e),
   });
 }
});


module.exports = router;



