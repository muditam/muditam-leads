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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeStr(x) {
  return String(x ?? "").trim();
}

function buildConversationTranscript(msgs = []) {
  // Keep it short & structured for the model
  return msgs
    .map((m) => {
      const dir = String(m.direction || "").toUpperCase() === "OUTBOUND" ? "AGENT" : "CUSTOMER";
      const t = safeStr(m.text);
      const ts = m.timestamp || m.createdAt || "";
      const mediaTag = m.media?.url ? ` [MEDIA:${m.type || "file"}]` : "";
      return `${dir}: ${t || ""}${mediaTag} (${ts})`.trim();
    })
    .join("\n");
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

    const leadName = safeStr(req.body?.leadName);
    const agentName = safeStr(req.body?.agentName);
    const goal = safeStr(req.body?.goal) || "Write the next best WhatsApp reply to the customer.";
    const tone = safeStr(req.body?.tone) || "friendly, professional, concise, Hinglish allowed";
    const maxMessages = Math.min(Number(req.body?.maxMessages || 30), 80);

    // Pull last messages for THIS phone (both directions)
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
You are an assistant helping a customer-support agent write a WhatsApp message.

Rules:
- Output ONLY the message text to send (no quotes, no headings).
- Keep it short and WhatsApp-friendly (1-5 lines).
- Match tone: ${tone}.
- If session is expired, suggest a message that politely asks for consent / offers to continue (template-friendly wording), but do NOT mention "template" explicitly.
- Never invent order details, medical claims, discounts, or policies not present in chat.
- If you need missing info, ask 1-2 clarifying questions in the same message.
`;

    const input = `
Context:
- Customer: ${leadName || phone10}
- Agent: ${agentName || "Support Agent"}
- Session active: ${sessionActive ? "YES" : "NO"}

Goal:
${goal}

Conversation (most recent at bottom):
${transcript || "(no prior messages found)"}

Now write the next message.
`.trim();

    const model = process.env.OPENAI_MODEL || "gpt-5-mini";

    // OpenAI Responses API
    const resp = await openai.responses.create({
      model,
      instructions,
      input,
      // optional: keep outputs shorter
      // max_output_tokens: 200,
    });

    const suggestion = safeStr(resp.output_text);

    if (!suggestion) {
      return res.status(500).json({ message: "AI did not return text" });
    }

    return res.json({ success: true, suggestion });
  } catch (e) {
    console.error("help-me-write error:", e);
    return res.status(500).json({
      message: "Help me write failed",
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
