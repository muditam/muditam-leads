// routes/dialerCampaignRoutes.js
const express = require("express");
const axios = require("axios");
const router = express.Router();
const Employee = require("../models/Employee");

// ENV
const SMARTFLO_BASE_URL =
  process.env.SMARTFLO_BASE_URL || "https://api-smartflo.tatateleservices.com/v1";
const SMARTFLO_TOKEN = process.env.SMARTFLO_TOKEN; // Put full value here; if your token requires the 'Bearer ' prefix, include it in the env itself.
const SMARTFLO_DISPOSITION_LIST_ID = process.env.SMARTFLO_DISPOSITION_LIST_ID || "ANS"; // optional fallback to "ANS"

// Helper: find the Employee doc by a hint from the frontend's session user
async function findEmployeeForRequest(employeeId) {
  try {
    const employee = await Employee.findById(employeeId).lean();
    return employee; // Returns the employee data (e.g., callerId, agentNumber)
  } catch (err) {
    console.error("Error fetching employee details:", err);
    throw new Error("Employee details not found.");
  }
}

/**
 * POST /api/dialer/campaign
 * Body:
 * {
 *   employeeId: string,   // employeeId passed from frontend
 *   contactNumber: string, // the contact number for the lead
 *   campaign: { ... } // campaign settings
 * }
 */
router.post("/campaign", async (req, res) => {
  console.log("[DialerAPI] /api/dialer/campaign hit. Body =", req.body);

  if (!SMARTFLO_TOKEN) {
    return res.status(500).json({
      status: "error",
      message: "SMARTFLO_TOKEN is missing in environment.",
    });
  }

  try {
    const { employeeId, contactNumber, campaign = {} } = req.body;

    // 1) Resolve employee (agent) from your DB
    const employee = await findEmployeeForRequest(employeeId);
    if (!employee) {
      return res
        .status(404)
        .json({ status: "error", message: "Employee not found for current user." });
    }

    // Required Smartflo fields + sensible defaults
    const payload = {
      name:
        campaign.name ||
        `LMS-${employee.fullName || "Agent"}-${Date.now()}`,
      description:
        campaign.description ||
        `Auto-created from LMS (${contactNumber || "no number"}) by ${employee.fullName || "Agent"}`,
      dial_method: String(campaign.dial_method || "1"), // default Preview mode
      outbound_caller_id: [employee.callerId],           // from your Employee schema
      disposition_list: String(
        campaign.disposition_list || SMARTFLO_DISPOSITION_LIST_ID || ""
      ),
      number_of_retry: String(campaign.number_of_retry ?? 2),
      retry_after_minutes: String(campaign.retry_after_minutes ?? 30),
      auto_disposition_cancel_duration: String(
        campaign.auto_disposition_cancel_duration ?? 30
      ),
      dial_status: campaign.dial_status || [1],  // Use numeric status ID (1 for "new")
      ring_timeout: String(campaign.ring_timeout ?? 20),
      hide_lead_details: Number(campaign.hide_lead_details ?? 0),
      update_lead_details: Number(campaign.update_lead_details ?? 1),
      dial_in_type: String(campaign.dial_in_type || "3"), // Dial Out (Session) by default
      agent_only_callback: Number(campaign.agent_only_callback ?? 1),
      agent: [Number(employee.agentNumber)], // <-- your 'agentNumber' is Smartflo Agent ID
      connect_agent_through: String(campaign.connect_agent_through || "3"),
    };

    // method-specific requirement: preview needs auto_dial_duration, ratio needs dial_ratio
    if (payload.dial_method === "1") {
      payload.auto_dial_duration = String(campaign.auto_dial_duration ?? 10);
    } else if (payload.dial_method === "2") {
      payload.dial_ratio = String(campaign.dial_ratio ?? 1);
    }

    // optional: attach existing lead lists to the campaign
    if (Array.isArray(campaign.lead_list_map) && campaign.lead_list_map.length) {
      payload.lead_list_map = campaign.lead_list_map;
    }

    // Validate a few critical fields
    const missing = [];
    if (!payload.disposition_list) missing.push("disposition_list (or SMARTFLO_DISPOSITION_LIST_ID env)");
    if (!payload.outbound_caller_id) missing.push("outbound_caller_id (from Employee.callerId)");
    if (!payload.agent || !payload.agent.length) missing.push("agent (from Employee.agentNumber)");

    if (missing.length) {
      return res.status(400).json({
        status: "error",
        message: `Missing required Smartflo fields: ${missing.join(", ")}`,
      });
    }

    // 2) Call Smartflo Add Dialer Campaign API
    const { data } = await axios.post(
      `${SMARTFLO_BASE_URL}/dialer/campaign`,
      payload,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: SMARTFLO_TOKEN, // supply full token here (include Bearer if required by your token format)
        },
        timeout: 20000,
      }
    );

    return res.json({ status: "success", smartflo: data, payloadUsed: payload });
  } catch (err) {
    const apiMsg = err?.response?.data || err.message;
    console.error("Smartflo create campaign error:", apiMsg);
    return res.status(500).json({
      status: "error",
      message: err?.response?.data?.Message || err.message,
      details: err?.response?.data || null,
    });
  }
});

module.exports = router;
