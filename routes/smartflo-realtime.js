const express = require("express");
const router = express.Router();

// Body parsers (safe to leave here if not set app-wide)
router.use(express.json({ limit: "1mb" }));
router.use(express.urlencoded({ extended: true }));

// ===== CORS (localhost + prod domains) =====
// NOTE: We DO NOT set Access-Control-Allow-Credentials here because the frontend
// EventSource is opened WITHOUT credentials. This avoids the wildcard-origin + credentials CORS error.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "https://60brands.com",
  "https://www.60brands.com",
]);

router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Fallback for tools/curl or environments without Origin
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,x-agent-number,x-webhook-token"
  );
  // DO NOT set Access-Control-Allow-Credentials unless your frontend uses cookies with EventSource
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ===== In-memory client registry (agentNumber -> Set of clientIds) =====
const clientsByAgent = new Map(); // key: agentNumber or "*" for broadcast
const allClients = new Map();     // clientId -> { res, agentNumber }
let nextClientId = 1;

function registerClient(res, agentNumber) {
  const id = String(nextClientId++);
  allClients.set(id, { res, agentNumber });
  const key = agentNumber || "*";
  if (!clientsByAgent.has(key)) clientsByAgent.set(key, new Set());
  clientsByAgent.get(key).add(id);
  return id;
}

function removeClient(id) {
  const rec = allClients.get(id);
  if (!rec) return;
  const key = rec.agentNumber || "*";
  const set = clientsByAgent.get(key);
  if (set) set.delete(id);
  allClients.delete(id);
}

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function notifyAgents(evt, agentNumber) {
  const payload = { type: "incoming_call", ...evt };

  if (agentNumber) {
    const set = clientsByAgent.get(String(agentNumber));
    if (set && set.size) {
      for (const id of set) {
        const c = allClients.get(id);
        if (c) sseSend(c.res, payload);
      }
      return;
    }
  }
  // fallback broadcast
  for (const [, c] of allClients) sseSend(c.res, payload);
}

// ===== SSE Stream =====
router.get("/events", (req, res) => {
  const agentNumber =
    (req.query.agentNumber && String(req.query.agentNumber)) ||
    (req.header("x-agent-number") && String(req.header("x-agent-number"))) ||
    null;

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // for nginx
  res.setHeader("Content-Encoding", "identity"); // avoid gzip buffering if compression middleware is on
  // Optional: suggest reconnection delay to the browser
  res.write("retry: 10000\n\n");

  // Flush headers immediately
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const clientId = registerClient(res, agentNumber);

  // Initial hello
  sseSend(res, { type: "hello", clientId, agentNumber, ts: new Date().toISOString() });

  // Heartbeat to keep connection open
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, 15000);

  const close = () => {
    clearInterval(ping);
    removeClient(clientId);
    try {
      res.end();
    } catch {}
  };

  req.on("close", close);
  req.on("aborted", close);
  req.on("error", close);
});

// ===== Smartflo Webhook (secure with SMARTFLO_TOKEN) =====
// Configure Smartflo to POST here: /api/smartflo/webhook
router.post("/webhook", (req, res) => {
  const body = req.body || {};

  // --- Simple shared-secret check ---
  const configured = process.env.SMARTFLO_TOKEN;
  const provided = req.get("x-webhook-token") || req.query.token;
  if (configured && configured !== provided) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Normalize fields (Smartflo payloads vary)
  const callerId =
    body.callerId ||
    body.callerid ||
    body.client_number ||
    body.customer_number ||
    body.customer ||
    body.from ||
    "";
  const agentNumber =
    body.agentNumber ||
    body.agent_number ||
    (body.agent && (body.agent.number || body.agent.id)) ||
    "";
  const didNumber = body.did_number || body.did || body.destination || body.to || "";
  const direction = (body.direction || "inbound").toLowerCase();
  const status = body.status || body.event || body.type || "ringing";
  const start = body.start_time || new Date().toISOString();
  const agentName =
    body.agent_name || (body.agent && (body.agent.name || body.agent.display_name)) || "";
  const asyncFlag = Number(body.async ?? 1);

  const event = {
    call_id:
      body.call_id ||
      body.session_id ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    callerid: callerId,
    did_number: didNumber,
    agent_name: agentName,
    agent_number: agentNumber,
    direction,
    status,
    start_time: start,
    async: asyncFlag,
  };

  notifyAgents(event, agentNumber || null);
  return res.status(200).json({ ok: true, received: true, async: asyncFlag });
});

// ===== Mock endpoint for local testing =====
// curl -X POST http://localhost:5001/api/smartflo/mock \
//   -H "Content-Type: application/json" \
//   -d '{"callerId":"919999888888","agentNumber":"1001","async":1}'
router.post("/mock", (req, res) => {
  const { callerId, agentNumber, async = 1 } = req.body || {};
  if (!callerId) return res.status(400).json({ error: "callerId is required" });

  const event = {
    call_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    callerid: String(callerId),
    did_number: req.body.did_number || "",
    agent_name: req.body.agent_name || "",
    agent_number: agentNumber ? String(agentNumber) : "",
    direction: "inbound",
    status: "ringing",
    start_time: new Date().toISOString(),
    async: Number(async),
  };

  notifyAgents(event, event.agent_number || null);
  return res.json({ ok: true, sent: event });
});

module.exports = router;
