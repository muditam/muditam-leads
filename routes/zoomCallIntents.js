const express = require("express");
const requireSession = require("../middleware/requireSession");
const ZoomCallIntent = require("../models/ZoomCallIntent");
const { getUserIdFromReq } = require("../services/zoomAuthService");

const router = express.Router();

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function toE164India(rawPhone = "") {
  const raw = String(rawPhone || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) {
    const d = digitsOnly(raw);
    return d ? `+${d}` : "";
  }
  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.length === 10) return `+91${d}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return "";
}

function toPhone10(rawPhone = "") {
  const d = digitsOnly(rawPhone);
  return d.slice(-10);
}

router.post("/", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const leadId = String(req.body?.leadId || "").trim();
    const sourcePage = String(req.body?.sourcePage || "").trim();
    const sourceContext = req.body?.sourceContext || {};
    const phoneRaw = String(req.body?.phoneNumber || "").trim();
    const dialNumberE164 = toE164India(phoneRaw);
    const phoneNumber = toPhone10(phoneRaw);

    if (!dialNumberE164 || !phoneNumber) {
      return res.status(400).json({ message: "Invalid phone number" });
    }

    const intentId = `intent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const intent = await ZoomCallIntent.create({
      intentId,
      userId,
      leadId,
      sourcePage,
      sourceContext,
      phoneRaw,
      phoneNumber,
      dialNumberE164,
      status: "initiated",
      lastEventAt: new Date(),
    });

    return res.json({
      intentId: intent.intentId,
      dialNumberE164: intent.dialNumberE164,
      status: intent.status,
      createdAt: intent.createdAt,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Failed to create call intent" });
  }
});

router.get("/:intentId", requireSession, async (req, res) => {
  const row = await ZoomCallIntent.findOne({ intentId: req.params.intentId }).lean();
  if (!row) return res.status(404).json({ message: "Not found" });
  return res.json(row);
});

module.exports = router;
