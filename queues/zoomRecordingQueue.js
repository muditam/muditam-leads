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

  // Placeholder implementation: fetch recording metadata and mark completed.
  // You can replace this with actual download/upload stream logic when Zoom account-level endpoint is finalized.
  const accessToken = await getValidAccessTokenForUser(call.agentId);
  const url = `https://api.zoom.us/v2/phone/call_logs/${encodeURIComponent(call.callId)}/recordings`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });

  const first = resp.data?.recordings?.[0] || {};
  call.recordingId = call.recordingId || first.id || "";
  call.recordingUrl = first.download_url || call.recordingUrl || "";
  call.recordingStatus = call.recordingUrl ? "completed" : "failed";
  call.transcriptStatus = call.recordingUrl ? "pending" : call.transcriptStatus;
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
