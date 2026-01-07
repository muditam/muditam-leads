// routes/whatsapp.ai.routes.js
const express = require("express");
const OpenAI = require("openai");

const WhatsAppMessage = require("./whatsaapModels/WhatsAppMessage");
const WhatsAppConversation = require("./whatsaapModels/WhatsAppConversation");

const router = express.Router();

const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);
const normalizeWaId = (v = "") => {
  const d = digitsOnly(v);
  if (d.length === 10) return `91${d}`;
  return d;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeStr(x) {
  return String(x ?? "").trim();
}
function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

// Don’t leak raw media URLs into the prompt. Keep only a tag.
function buildConversationTranscript(msgs = []) {
  return (msgs || [])
    .map((m) => {
      const dir = String(m.direction || "").toUpperCase() === "OUTBOUND" ? "AGENT" : "CUSTOMER";
      const t = safeStr(m.text);
      const mediaTag = m.media?.url ? ` [MEDIA:${m.type || "file"}]` : "";
      // Keep timestamps optional; they add tokens and rarely help
      return `${dir}: ${t || ""}${mediaTag}`.trim();
    })
    .filter(Boolean)
    .join("\n");
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

    const convo = await WhatsAppConversation.findOne({ phone: waId }).lean();

    const transcript = buildConversationTranscript((msgs || []).reverse()); // oldest -> newest
    const sessionActive =
      convo?.windowExpiresAt && new Date(convo.windowExpiresAt).getTime() > Date.now();

    const instructions = `
You help a support agent write a WhatsApp message.

Rules:
- Output ONLY the message text (no quotes, no headings).
- Keep it WhatsApp-friendly and short (1-5 lines).
- Match tone: ${tone}.
- If session is expired: write a polite message that asks to continue the conversation / get consent, without mentioning "template".
- Never invent order details, medical claims, discounts, or policies not present in chat.
- If missing info is required, ask 1-2 clarifying questions inside the message.
`.trim();

    const input = `
Context:
- Customer: ${leadName || phone10}
- Agent: ${agentName || "Support Agent"}
- Session active: ${sessionActive ? "YES" : "NO"}

Goal:
${goal}

Conversation (most recent at bottom):
${transcript || "(no prior messages found)"}

Write the next message now.
`.trim();

    const suggestion = await callOpenAI({
      instructions,
      input,
      maxOutputTokens: 220,
    });

    if (!suggestion) return res.status(500).json({ message: "AI did not return text" });

    return res.json({ success: true, suggestion });
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

    if (!result) return res.status(500).json({ message: "AI did not return text" });

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
