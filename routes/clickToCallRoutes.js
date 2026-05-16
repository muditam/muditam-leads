// routes/clickToCall.routes.js
const express = require("express");
const ZoomCallLog = require("../models/ZoomCallLog");
const requireSession = require("../middleware/requireSession");

const router = express.Router();

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

// Normalize to E.164-ish for India defaults (adjust if you call other countries)
function toE164India(v) {
  const d = digitsOnly(v);
  if (!d) return "";

  // If already has country code 91 (12 digits like 91XXXXXXXXXX)
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;

  // If plain 10-digit Indian mobile
  if (d.length === 10) return `+91${d}`;

  // Fallback: if it already looks like a long international number, prefix +
  if (d.length >= 11 && d.length <= 15) return `+${d}`;

  return "";
}

router.post("/click_to_call", requireSession, async (req, res) => {
  try {
    const destination_number = toE164India(req.body.destination_number);
    if (!destination_number) {
      return res.status(400).json({ status: "error", message: "Missing destination_number" });
    }

    const user = req.sessionUser || req.session?.user || null;
    const callId = `crm-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ZoomCallLog.create({
      callId,
      agentId: user?.id || user?._id || undefined,
      direction: "outbound",
      phoneNumber: destination_number,
      calleeNumber: destination_number,
      status: "dial_requested_from_crm",
      metadata: {
        source: "legacy_click_to_call_endpoint",
        note: "Zoom call placement is triggered via frontend embed postMessage.",
      },
    });

    return res.json({
      status: "success",
      message: "Dial request captured. Open Calling Center to place the call in Zoom softphone.",
      zoom: { callId, destination_number },
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message || "Failed to queue Zoom call" });
  }
});

module.exports = router;
