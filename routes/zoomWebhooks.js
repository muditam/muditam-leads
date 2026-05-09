const express = require("express");
const crypto = require("crypto");
const ZoomCallLog = require("../models/ZoomCallLog");
const ZoomWebhookEvent = require("../models/ZoomWebhookEvent");
const ZoomToken = require("../models/ZoomToken");
const recordingQueue = require("../queues/zoomRecordingQueue");

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

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(401).json({ message: "Invalid signature" });

    const event = JSON.parse(req.body.toString("utf8") || "{}");
    const eventType = String(event.event || "unknown");
    const payload = event.payload?.object || event.payload || {};
    const callId = String(payload.call_id || payload.id || "");
    const eventId = String(event.event_ts || Date.now()) + ":" + eventType + ":" + callId;

    const exists = await ZoomWebhookEvent.findOne({ eventId }).lean();
    if (exists) return res.status(200).json({ ok: true, deduped: true });

    await ZoomWebhookEvent.create({ eventId, eventType, callId, payload, processed: false });

    if (eventType.includes("call")) {
      const zoomUserId = String(payload.user_id || payload.owner_id || "");
      const agentId = await resolveAgentIdByZoomUserId(zoomUserId);

      const update = {
        zoomUserId,
        agentId,
        direction: payload.direction || "unknown",
        phoneNumber: payload.caller_number || payload.callee_number || payload.phone_number || "",
        callerNumber: payload.caller_number || "",
        calleeNumber: payload.callee_number || "",
        status: payload.status || eventType,
        metadata: payload,
      };

      if (payload.start_time) update.startTime = new Date(payload.start_time);
      if (payload.end_time) update.endTime = new Date(payload.end_time);
      if (payload.call_duration != null) update.duration = Number(payload.call_duration) || 0;

      await ZoomCallLog.findOneAndUpdate(
        { callId },
        { $set: update, $setOnInsert: { callId } },
        { upsert: true, new: true }
      );
    }

    if (eventType.includes("recording") && callId) {
      await ZoomCallLog.findOneAndUpdate(
        { callId },
        {
          $set: {
            recordingId: String(payload.recording_id || ""),
            recordingStatus: "pending",
            transcriptStatus: "pending",
          },
          $setOnInsert: { callId },
        },
        { upsert: true }
      );
      recordingQueue.enqueue({ callId, delayMs: 30000 });
    }

    await ZoomWebhookEvent.updateOne({ eventId }, { processed: true, processingError: "" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Zoom webhook error", err.message);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
