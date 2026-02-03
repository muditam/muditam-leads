// routes/clickToCall.routes.js
const express = require("express");
const axios = require("axios");

const router = express.Router();

const SMARTFLO_BASE_URL =
  (process.env.SMARTFLO_BASE_URL || "https://api-smartflo.tatateleservices.com").replace(/\/+$/, "");

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

// Decide which token to use.
// You can improve this later based on caller_id / agent_number mapping.
function pickSmartfloToken({ caller_id, agent_number }) {
  const caller = toE164India(caller_id) || String(caller_id || "").trim();
  const agent = digitsOnly(agent_number);

  // Optional env mapping (recommended)
  const caller2 = process.env.SMARTFLO_CALLER_ID_2 ? toE164India(process.env.SMARTFLO_CALLER_ID_2) : "";
  const agent2 = process.env.SMARTFLO_AGENT_NUMBER_2 ? digitsOnly(process.env.SMARTFLO_AGENT_NUMBER_2) : "";

  if ((caller2 && caller === caller2) || (agent2 && agent === agent2)) {
    return process.env.SMARTFLO_TOKEN_2 || "";
  }
  return process.env.SMARTFLO_TOKEN || "";
}

router.post("/click_to_call", async (req, res) => {
  try {
    const destination_number = toE164India(req.body.destination_number);
    const agent_number = digitsOnly(req.body.agent_number);
    const caller_id = toE164India(req.body.caller_id);

    // Smartflo expects async flag (you are sending async: 1)
    const asyncFlag = Number(req.body.async) === 1 ? 1 : 0;

    if (!destination_number || !agent_number || !caller_id) {
      return res.status(400).json({
        status: "error",
        message: "Missing/invalid call parameters",
        missing: {
          destination_number: !destination_number,
          agent_number: !agent_number,
          caller_id: !caller_id,
        },
      });
    }

    const token = pickSmartfloToken({ caller_id, agent_number });
    if (!token) {
      return res.status(500).json({
        status: "error",
        message: "Smartflo token not configured on server",
      });
    }

    const payload = {
      destination_number, // customer
      agent_number,       // agent
      caller_id,          // DID / outbound identity
      async: asyncFlag,   // 1 recommended for non-blocking
    };

    const url = `${SMARTFLO_BASE_URL}/v1/click_to_call`;  

    const sfResp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    });

    // Return a consistent shape to frontend
    return res.json({
      status: "success",
      message: "Call triggered",
      smartflo: sfResp.data, // keep for debugging; remove if you want
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || null;

    console.error("Smartflo click_to_call error:", {
      status,
      data,
      message: err.message,
    });

    return res.status(status).json({
      status: "error",
      message: "Failed to place the call",
      smartflo: data,
    });
  }
});

module.exports = router;
