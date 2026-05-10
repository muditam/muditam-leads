const express = require("express");
const crypto = require("crypto");
const ZoomCallLog = require("../models/ZoomCallLog");
const ZoomWebhookEvent = require("../models/ZoomWebhookEvent");
const ZoomToken = require("../models/ZoomToken");
const ZoomCallIntent = require("../models/ZoomCallIntent");
const Employee = require("../models/Employee");
const recordingQueue = require("../queues/zoomRecordingQueue");
const { broadcastManagerOverviewUpdate } = require("../services/callingManagerOverviewStream");

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET || "";
  if (!secret) return true;
  const ts = req.headers["x-zm-request-timestamp"];
  const sig = req.headers["x-zm-signature"];
  if (!ts || !sig) return false;

  const payload = req.body?.toString("utf8") || "";
  const message = `v0:${ts}:${payload}`;
  const hash = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return sig === `v0=${hash}`;
}

async function resolveAgentIdByZoomUserId(zoomUserId) {
  const rec = await ZoomToken.findOne({ zoomUserId }).select("userId").lean();
  return rec?.userId || null;
}

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function toPhone10(v = "") {
  return digitsOnly(v).slice(-10);
}

async function resolveAgentIdByNumbers(payload = {}) {
  const caller10 = toPhone10(payload.caller_number || "");
  const callee10 = toPhone10(payload.callee_number || "");
  if (!caller10 && !callee10) return null;

  const employees = await Employee.find(
    {
      status: "active",
      $or: [
        { callerId: { $exists: true, $ne: null } },
        { agentNumber: { $exists: true, $ne: null } },
      ],
    },
    { _id: 1, callerId: 1, agentNumber: 1 }
  ).lean();

  for (const e of employees) {
    const c = toPhone10(e.callerId || "");
    const a = toPhone10(e.agentNumber || "");
    if (caller10 && (caller10 === c || caller10 === a)) return e._id;
    if (callee10 && (callee10 === c || callee10 === a)) return e._id;
  }
  return null;
}

function deriveDirection(payload = {}) {
  const d = String(payload.direction || "").toLowerCase();
  if (d === "inbound" || d === "outbound") return d;
  return "unknown";
}

function deriveStatusFromEvent(eventType = "") {
  const type = String(eventType || "").toLowerCase();
  if (type.includes("ringing")) return "ringing";
  if (type.includes("answered") || type.includes("connected")) return "connected";
  if (type.includes("missed")) return "missed";
  if (type.includes("rejected")) return "rejected";
  if (type.includes("ended")) return "ended";
  if (type.includes("completed")) return "completed";
  if (type.includes("failed")) return "failed";
  return "updated";
}

function deriveOutcome(status = "") {
  const s = String(status || "").toLowerCase();
  if (s === "connected" || s === "completed") return "answered";
  if (s === "missed") return "missed";
  if (s === "rejected") return "rejected";
  if (s === "failed") return "failed";
  if (s === "ended") return "ended";
  return "unknown";
}

function buildCallLogKey(payload = {}, eventId = "") {
  const callId = String(payload.call_id || payload.id || "");
  if (callId) return { callId, callHistoryUuid: String(payload.call_history_uuid || "") };
  const callHistoryUuid = String(payload.call_history_uuid || "");
  if (callHistoryUuid) return { callId: `history-${callHistoryUuid}`, callHistoryUuid };
  const callElementId = String(payload.call_element_id || "");
  if (callElementId) return { callId: `element-${callElementId}`, callHistoryUuid: "" };
  return { callId: `evt-${eventId}`, callHistoryUuid: "" };
}

async function reconcileIntent({ agentId, phoneNumber, callId, callHistoryUuid, callElementId, status, eventType, eventAt }) {
  if (!agentId || !phoneNumber) return null;

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const intent = await ZoomCallIntent.findOne({
    userId: agentId,
    phoneNumber,
    createdAt: { $gte: twoHoursAgo },
    status: { $in: ["initiated", "ringing", "connected"] },
  }).sort({ createdAt: -1 });

  if (!intent) return null;

  intent.callId = callId || intent.callId;
  intent.callHistoryUuid = callHistoryUuid || intent.callHistoryUuid;
  intent.callElementId = callElementId || intent.callElementId;
  intent.status = status === "completed" ? "ended" : status;
  intent.lastEventType = eventType;
  intent.lastEventAt = eventAt;
  if (!intent.matchedAt) intent.matchedAt = eventAt;
  if (["ended", "failed", "missed", "rejected"].includes(intent.status)) intent.endedAt = eventAt;
  await intent.save();

  return intent;
}

function isCallLifecycleEvent(eventType = "") {
  const type = String(eventType || "").toLowerCase();
  return (
    type.startsWith("phone.caller_") ||
    type.startsWith("phone.callee_") ||
    type.includes("call_element_completed")
  );
}

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(401).json({ message: "Invalid signature" });

    const event = JSON.parse(req.body.toString("utf8") || "{}");
    if (String(event.event || "") === "endpoint.url_validation") {
      const plainToken = String(event.payload?.plainToken || "");
      const encryptedToken = crypto
        .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET || "")
        .update(plainToken)
        .digest("hex");
      return res.status(200).json({ plainToken, encryptedToken });
    }

    const eventType = String(event.event || "unknown");
    const payload = event.payload?.object || event.payload || {};
    const eventAt = new Date(Number(event.event_ts || Date.now()));
    const ids = buildCallLogKey(payload, `${event.event_ts || Date.now()}`);
    const callId = ids.callId;
    const callHistoryUuid = String(payload.call_history_uuid || ids.callHistoryUuid || "");
    const callElementId = String(payload.call_element_id || "");
    const eventId = String(event.event_id || `${event.event_ts || Date.now()}:${eventType}:${callId}`);

    const exists = await ZoomWebhookEvent.findOne({ eventId }).lean();
    if (exists) return res.status(200).json({ ok: true, deduped: true });

    await ZoomWebhookEvent.create({ eventId, eventType, callId, payload, processed: false });

    if (isCallLifecycleEvent(eventType)) {
      const zoomUserId = String(payload.user_id || payload.owner_id || "");
      let agentId = await resolveAgentIdByZoomUserId(zoomUserId);
      if (!agentId) {
        agentId = await resolveAgentIdByNumbers(payload);
      }
      const direction = deriveDirection(payload);
      const status = deriveStatusFromEvent(eventType);
      const outcome = deriveOutcome(status);
      const phoneNumberRaw = payload.caller_number || payload.callee_number || payload.phone_number || "";
      const phoneNumber = toPhone10(phoneNumberRaw);

      const intent = await reconcileIntent({
        agentId,
        phoneNumber,
        callId,
        callHistoryUuid,
        callElementId,
        status,
        eventType,
        eventAt,
      });

      const update = {
        zoomUserId,
        agentId,
        direction,
        outcome,
        phoneNumber: phoneNumberRaw,
        callerNumber: payload.caller_number || "",
        calleeNumber: payload.callee_number || "",
        status,
        callHistoryUuid,
        callElementId,
        eventType,
        metadata: payload,
      };

      if (Array.isArray(payload.call_elements)) {
        update.callElementIds = payload.call_elements
          .map((el) => String(el?.call_element_id || "").trim())
          .filter(Boolean);
      }

      if (intent) {
        update.intentId = intent.intentId;
        update.leadId = intent.leadId || "";
        update.sourcePage = intent.sourcePage || "";
        update.dialInitiatedAt = intent.createdAt;
      }

      if (payload.start_time) update.startTime = new Date(payload.start_time);
      if (payload.end_time) update.endTime = new Date(payload.end_time);
      if (payload.call_duration != null) update.duration = Number(payload.call_duration) || 0;

      await ZoomCallLog.findOneAndUpdate(
        { callId },
        { $set: update, $setOnInsert: { callId } },
        { upsert: true, new: true }
      );
      broadcastManagerOverviewUpdate().catch(() => {});
    }

    if (eventType === "phone.recording_completed" && callId) {
      await ZoomCallLog.findOneAndUpdate(
        { callId },
        {
          $set: {
            recordingId: String(payload.recording_id || ""),
            recordingStatus: "pending",
            transcriptStatus: "pending",
            callElementId: callElementId || undefined,
            callHistoryUuid: callHistoryUuid || undefined,
            eventType,
          },
          $setOnInsert: { callId },
        },
        { upsert: true }
      );
      broadcastManagerOverviewUpdate().catch(() => {});
      recordingQueue.enqueue({ callId, callElementId, delayMs: 30000 });
    }

    if (eventType === "phone.voicemail_received") {
      await ZoomCallLog.findOneAndUpdate(
        { callId },
        {
          $set: {
            status: "voicemail_received",
            outcome: "missed",
            eventType,
            metadata: payload,
            callHistoryUuid: callHistoryUuid || undefined,
            callElementId: callElementId || undefined,
          },
          $setOnInsert: { callId },
        },
        { upsert: true }
      );
      broadcastManagerOverviewUpdate().catch(() => {});
    }

    if (eventType === "phone.emergency_alert") {
      await ZoomCallLog.findOneAndUpdate(
        { callId },
        {
          $set: {
            status: "emergency_alert",
            eventType,
            metadata: payload,
            callHistoryUuid: callHistoryUuid || undefined,
            callElementId: callElementId || undefined,
          },
          $setOnInsert: { callId },
        },
        { upsert: true }
      );
      broadcastManagerOverviewUpdate().catch(() => {});
    }

    await ZoomWebhookEvent.updateOne({ eventId }, { processed: true, processingError: "" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Zoom webhook error", err.message);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
