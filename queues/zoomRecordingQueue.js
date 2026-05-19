const axios = require("axios");
const ZoomCallLog = require("../models/ZoomCallLog");
const { getValidAccessTokenForUser } = require("../services/zoomAuthService");

let started = false;
let polling = false;
const LEASE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;

function enqueue(job) {
  const delayMs = Number(job?.delayMs || 30000);
  const runAt = new Date(Date.now() + delayMs);
  return ZoomCallLog.findOneAndUpdate(
    { callId: job.callId },
    {
      $set: {
        recordingStatus: "pending",
        transcriptStatus: "pending",
        recordingNextAttemptAt: runAt,
        recordingLeaseUntil: null,
        ...(job.callElementId ? { callElementId: String(job.callElementId) } : {}),
      },
      $setOnInsert: {
        callId: job.callId,
        recordingAttempts: 0,
      },
    },
    { upsert: true }
  );
}

async function processOne(call) {
  if (!call || !call.agentId) {
    await ZoomCallLog.updateOne(
      { callId: call?.callId },
      {
        $set: {
          recordingStatus: "failed",
          transcriptStatus: "failed",
          recordingLeaseUntil: null,
        },
      }
    );
    return;
  }

  // v3 hard-cutover: fetch call element details and read recording metadata from element payload.
  const accessToken = await getValidAccessTokenForUser(call.agentId);
  const callElementId = String(call.callElementId || "");
  if (!callElementId) {
    await ZoomCallLog.updateOne(
      { callId: call.callId },
      {
        $set: {
          recordingStatus: "failed",
          transcriptStatus: "failed",
          recordingLeaseUntil: null,
        },
      }
    );
    return;
  }

  const url = `https://api.zoom.us/v2/phone/call_element/${encodeURIComponent(callElementId)}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });

  const recording = resp.data?.recording || {};
  const recordingUrl =
    recording.download_url || recording.recording_download_url || call.recordingUrl || "";

  await ZoomCallLog.updateOne(
    { callId: call.callId },
    {
      $set: {
        recordingId: call.recordingId || recording.recording_id || recording.id || "",
        recordingUrl,
        recordingStatus: recordingUrl ? "completed" : "failed",
        transcriptStatus: recordingUrl ? "pending" : call.transcriptStatus,
        callHistoryUuid: call.callHistoryUuid || String(resp.data?.call_history_uuid || ""),
        callElementId: call.callElementId || callElementId,
        recordingLeaseUntil: null,
        recordingNextAttemptAt: null,
      },
    }
  );
}

async function claimOne() {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  return ZoomCallLog.findOneAndUpdate(
    {
      recordingStatus: "pending",
      $and: [
        {
          $or: [
            { recordingNextAttemptAt: null },
            { recordingNextAttemptAt: { $exists: false } },
            { recordingNextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { recordingLeaseUntil: null },
            { recordingLeaseUntil: { $exists: false } },
            { recordingLeaseUntil: { $lt: now } },
          ],
        },
      ],
    },
    {
      $set: {
        recordingStatus: "downloading",
        recordingLeaseUntil: leaseUntil,
      },
      $inc: {
        recordingAttempts: 1,
      },
    },
    {
      sort: { recordingNextAttemptAt: 1, updatedAt: 1 },
      new: true,
    }
  ).lean();
}

async function processTick() {
  if (polling) return;
  polling = true;

  try {
    const call = await claimOne();
    if (!call) return;

    try {
      await processOne(call);
    } catch (err) {
      const attempts = Number(call.recordingAttempts || 0);
      if (attempts < MAX_ATTEMPTS) {
        await ZoomCallLog.updateOne(
          { callId: call.callId },
          {
            $set: {
              recordingStatus: "pending",
              recordingLeaseUntil: null,
              recordingNextAttemptAt: new Date(Date.now() + 30000 * attempts),
            },
          }
        );
      } else {
        await ZoomCallLog.updateOne(
          { callId: call.callId },
          {
            $set: {
              recordingStatus: "failed",
              transcriptStatus: "failed",
              recordingLeaseUntil: null,
              recordingNextAttemptAt: null,
            },
          }
        );
      }
    }
  } finally {
    polling = false;
  }
}

function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    processTick().catch(() => {});
  }, 3000);
}

module.exports = { enqueue, start };
