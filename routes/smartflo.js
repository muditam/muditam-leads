// routes/smartflo.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

/**
 * ENV needed:
 * SMARTFLO_BASE_URL=https://api-smartflo.tatateleservices.com
 * SMARTFLO_TOKEN=...      // raw JWT for account 1
 * SMARTFLO_TOKEN_2=...    // raw JWT for account 2 (optional)
 */

const SMARTFLO_BASE = (
  process.env.SMARTFLO_BASE_URL || "https://api-smartflo.tatateleservices.com"
).replace(/\/+$/g, "");

const api = axios.create({
  baseURL: SMARTFLO_BASE,
  timeout: 0,
});

// normalize env token -> Authorization header value
function normalizeAuthToken(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  // if already "Bearer xxx"
  if (/^Bearer\s+/i.test(trimmed)) return trimmed;
  // Smartflo bearer auth: "Bearer <token>"
  return `Bearer ${trimmed}`;
}

// helper: build CDR query from request
function buildCdrQuery(q) {
  const {
    from_date,
    to_date,
    page = 1,
    limit = 20,
    direction,
    call_type,
    callerid,
    destination,
    did_number,
    agents,
    department,
    ivr,
    duration,
    operator,
    services,
    broadcast,
  } = q;

  const params = {
    from_date,
    to_date,
    page,
    limit,
  };

  if (direction) params.direction = direction;
  if (call_type) params.call_type = call_type;
  if (callerid) params.callerid = callerid;
  if (destination) params.destination = destination;
  if (did_number) params.did_number = did_number;
  if (agents) params.agents = agents.split(",");
  if (department) params.department = department.split(",");
  if (ivr) params.ivr = ivr.split(",");
  if (duration) params.duration = duration;
  if (operator) params.operator = operator;
  if (services) params.services = services;
  if (broadcast) params.broadcast = broadcast;

  return params;
}

/**
 * Pass-through: GET /api/smartflo/call-records
 * Useful for debugging one token directly.
 */
router.get("/call-records", async (req, res) => {
  try {
    const auth = normalizeAuthToken(process.env.SMARTFLO_TOKEN);
    if (!auth) {
      return res
        .status(500)
        .json({ error: "SMARTFLO_TOKEN not configured on server." });
    }

    const params = buildCdrQuery(req.query);

    if (!params.from_date || !params.to_date) {
      return res.status(400).json({
        error: "from_date and to_date are required in format 'YYYY-MM-DD HH:mm:ss'",
      });
    }

    const resp = await api.get("/v1/call/records", {
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
      params,
    });

    return res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    return res.status(status).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
});

// fetch all pages for ONE token for given day-range
async function fetchAllForToken(auth, from_date, to_date) {
  const all = [];
  const limitPerPage = 200;
  let page = 1;

  for (;;) {
    const resp = await api.get("/v1/call/records", {
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
      params: {
        from_date,
        to_date,
        page,
        limit: limitPerPage,
      },
    });

    const chunk = resp.data?.results || [];
    all.push(...chunk);

    if (chunk.length < limitPerPage) {
      break; // last page for this token
    }

    page += 1;
  }

  return all;
}

/**
 * Aggregated overview:
 * GET /api/smartflo/overview
 * - default: today's IST window
 * - override: ?from_date=YYYY-MM-DD HH:mm:ss&to_date=...
 * - combines SMARTFLO_TOKEN + SMARTFLO_TOKEN_2
 */
router.get("/overview", async (req, res) => {
  try {
    const tokensRaw = [
      process.env.SMARTFLO_TOKEN,
      process.env.SMARTFLO_TOKEN_2,
    ].filter(Boolean);

    const tokens = tokensRaw.map(normalizeAuthToken).filter(Boolean);

    if (!tokens.length) {
      return res.status(500).json({
        error:
          "At least one of SMARTFLO_TOKEN or SMARTFLO_TOKEN_2 must be configured.",
      });
    }

    // Date window
    let { from_date, to_date } = req.query;
    let istYmd;

    if (!from_date || !to_date) {
      const now = new Date();
      const toISTDate = (d) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d);

      istYmd = toISTDate(now); // e.g. "2025-11-03"
      from_date = `${istYmd} 00:00:00`;
      to_date = `${istYmd} 23:59:59`;
    } else {
      istYmd = from_date.slice(0, 10);
    }

    console.log("[Smartflo overview] Fetching CDRs", {
      from_date,
      to_date,
      tokens: tokens.length,
    });

    let all = [];
    const tokenErrors = [];

    // Fetch from ALL tokens and merge
    for (const auth of tokens) {
      try {
        const chunk = await fetchAllForToken(auth, from_date, to_date);
        console.log(
          "[Smartflo overview] token fetched records:",
          chunk.length
        );
        all.push(...chunk);
      } catch (e) {
        const msg = e.response?.data || e.message || "Unknown error";
        console.error("[Smartflo overview] token error:", msg);
        tokenErrors.push(msg);
      }
    }

    console.log("[Smartflo overview] total merged records:", all.length);

    // ---- aggregate ----
    let totalCalls = 0;
    let incomingCalls = 0;
    let dialledCalls = 0;
    let dialledConnected = 0;
    let answeredOutbound = 0;
    let missed = 0;
    let totalDuration = 0;

    const agents = new Map();

    const toLower = (v) => (v || "").toString().toLowerCase();
    const num = (v) => Number(v || 0);

    for (const r of all) {
      totalCalls += 1;

      const direction = toLower(r.direction); // inbound/outbound
      const status = toLower(r.status);
      const duration = num(r.call_duration);
      const answeredSeconds = num(r.answered_seconds);

      const isAnswered =
        answeredSeconds > 0 ||
        ["answered", "completed", "connected"].includes(status);
      const isMissed = !isAnswered;

      if (direction === "inbound") {
        incomingCalls += 1;
      } else if (direction === "outbound") {
        dialledCalls += 1;
        if (isAnswered) {
          dialledConnected += 1;
          answeredOutbound += 1;
        }
      }

      if (isMissed) missed += 1;
      totalDuration += duration;

      const agentName =
        r.agent_name ||
        r.agent_number ||
        (r.agent && (r.agent.name || r.agent.number)) ||
        "Unknown";

      if (!agents.has(agentName)) {
        agents.set(agentName, {
          agent: agentName,
          totalDialled: 0,
          _dialledSet: new Set(),
          callsConnected: 0,
          incomingCalls: 0,
          missedCalls: 0,
          duration: 0,
          count: 0,
        });
      }

      const a = agents.get(agentName);
      a.count += 1;
      a.duration += duration;

      const clientNumber = (r.client_number || r.callerid || "").toString();

      if (direction === "outbound") {
        a.totalDialled += 1;
        if (clientNumber) a._dialledSet.add(clientNumber);
        if (isAnswered) a.callsConnected += 1;
      } else if (direction === "inbound") {
        a.incomingCalls += 1;
        if (isMissed) a.missedCalls += 1;
      } else if (isMissed) {
        a.missedCalls += 1;
      }
    }

    const avgDuration = totalCalls ? Math.round(totalDuration / totalCalls) : 0;

    const agentsArr = Array.from(agents.values()).map((a) => ({
      agent: a.agent,
      totalDialled: a.totalDialled,
      uniqueDialled: a._dialledSet.size,
      callsConnected: a.callsConnected,
      incomingCalls: a.incomingCalls,
      missedCalls: a.missedCalls,
      avgDuration: a.count ? Math.round(a.duration / a.count) : 0,
    }));

    return res.json({
      summary: {
        totalCalls,
        incomingCalls,
        dialledCalls,
        dialledConnected,
        answeredOutbound,
        missed,
        avgDuration,
      },
      agents: agentsArr,
      totalFetched: all.length,
      tokensUsed: tokens.length,
      date: istYmd,
      debug: {
        from_date,
        to_date,
        tokenErrors,
      },
    });
  } catch (err) {
    const status = err.response?.status || 500; 
    console.error("[Smartflo overview] ERROR:", err.response?.data || err);
    return res.status(status).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
});

module.exports = router;


