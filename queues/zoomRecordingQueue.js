const axios = require("axios");
const ZoomCallLog = require("../models/ZoomCallLog");
const { getValidAccessTokenForUser } = require("../services/zoomAuthService");

const jobs = [];
let started = false;

function enqueue(job) {
  jobs.push({ ...job, attempts: 0, runAt: Date.now() + (job.delayMs || 30000) });
}

async function processOne(job) {
  const call = await ZoomCallLog.findOne({ callId: job.callId });
  if (!call || !call.agentId) return;

  call.recordingStatus = "downloading";
  await call.save();

  // v3 hard-cutover: fetch call element details and read recording metadata from element payload.
  const accessToken = await getValidAccessTokenForUser(call.agentId);
  const callElementId = String(job.callElementId || call.callElementId || "");
  if (!callElementId) {
    call.recordingStatus = "failed";
    call.transcriptStatus = "failed";
    await call.save();
    return;
  }

  const url = `https://api.zoom.us/v2/phone/call_element/${encodeURIComponent(callElementId)}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });

  const recording = resp.data?.recording || {};
  call.recordingId = call.recordingId || recording.recording_id || recording.id || "";
  call.recordingUrl = recording.download_url || recording.recording_download_url || call.recordingUrl || "";
  call.recordingStatus = call.recordingUrl ? "completed" : "failed";
  call.transcriptStatus = call.recordingUrl ? "pending" : call.transcriptStatus;
  call.callHistoryUuid = call.callHistoryUuid || String(resp.data?.call_history_uuid || "");
  call.callElementId = call.callElementId || callElementId;
  await call.save();
}

function start() {
  if (started) return;
  started = true;
  setInterval(async () => {
    if (!jobs.length) return;
    const now = Date.now();
    const idx = jobs.findIndex((j) => j.runAt <= now);
    if (idx === -1) return;

    const job = jobs.splice(idx, 1)[0];
    try {
      await processOne(job);
    } catch (err) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts < 3) {
        jobs.push({ ...job, attempts, runAt: Date.now() + 30000 * attempts });
      } else {
        await ZoomCallLog.findOneAndUpdate(
          { callId: job.callId },
          { recordingStatus: "failed", transcriptStatus: "failed" }
        );
      }
    }
  }, 3000);
}

module.exports = { enqueue, start };
