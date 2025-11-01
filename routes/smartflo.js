// routes/smartflo.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

/**
 * ENV needed:
 * SMARTFLO_BASE_URL=https://api-smartflo.tatateleservices.com
 * SMARTFLO_TOKEN=...     // put EXACT token here (e.g. "Bearer=xxxx" or "Bearer xxxx")
 */

// NOTE: no timeout here (0 = no timeout)
const api = axios.create({
  baseURL: process.env.SMARTFLO_BASE_URL || "https://api-smartflo.tatateleservices.com",
  timeout: 0,
});

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
 * NORMAL passthrough: /api/smartflo/call-records
 * (kept as-is for your logs page)
 */
router.get("/call-records", async (req, res) => {
  try {
    const token = process.env.SMARTFLO_TOKEN;
    if (!token) {
      return res.status(500).json({ error: "SMARTFLO_TOKEN not configured on server." });
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
        Authorization: token,
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

/**
 * /api/smartflo/overview
 * - ALWAYS uses **today** (IST) 00:00:00 → 23:59:59
 * - NO artificial limit / max_pages in code
 * - will page until Smartflo stops sending data
 * - SHAPE:
 *    {
 *      summary: { totalCalls, incomingCalls, dialledCalls, dialledConnected, answeredOutbound, missed, avgDuration },
 *      agents: [...],
 *      totalFetched
 *    }
 */
router.get("/overview", async (req, res) => {
  try {
    const token = process.envSMARTFLO_TOKEN || process.env.SMARTFLO_TOKEN;
    if (!token) {
      return res.status(500).json({ error: "SMARTFLO_TOKEN not configured on server." });
    }

    // 1) build TODAY (IST)
    // server is probably UTC, so we just hard-format to IST clock manually
    // today: 2025-10-31 as per your environment, but we compute dynamically
    const now = new Date();
    // get YYYY-MM-DD in IST
    const toIST = (d) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);

    const istYmd = toIST(now); // "2025-10-31"
    const from_date = `${istYmd} 00:00:00`;
    const to_date = `${istYmd} 23:59:59`;

    // 2) we will NOT cap limit/max_pages here
    // but Smartflo still needs a page + limit
    // we’ll request 200 per page and keep paging until Smartflo sends < 200
    const limitPerPage = 200;

    const all = [];
    let page = 1;

    for (;;) {
      const resp = await api.get("/v1/call/records", {
        headers: {
          Accept: "application/json",
          Authorization: token,
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
        // last page
        break;
      }

      page += 1;
    }

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
        answeredSeconds > 0 || ["answered", "completed", "connected"].includes(status);
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

      if (isMissed) {
        missed += 1;
      }

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
        if (clientNumber) {
          a._dialledSet.add(clientNumber);
        }
        if (isAnswered) {
          a.callsConnected += 1;
        }
      } else if (direction === "inbound") {
        a.incomingCalls += 1;
        if (isMissed) {
          a.missedCalls += 1;
        }
      } else {
        if (isMissed) {
          a.missedCalls += 1;
        }
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
      date: istYmd,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    return res.status(status).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
});

module.exports = router;
