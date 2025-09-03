// routes/smartflo.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

/**
 * ENV you need (e.g. in .env):
 * SMARTFLO_BASE_URL=https://api-smartflo.tatateleservices.com
 * SMARTFLO_TOKEN=YOUR_BEARER_OR_PERMANENT_TOKEN
 *   - If you don't have a permanent token, generate/refresh short-lived as per docs:
 *     POST /v1/auth/login -> access_token, then set SMARTFLO_TOKEN at runtime.
 */

const api = axios.create({
  baseURL: process.env.SMARTFLO_BASE_URL || "https://api-smartflo.tatateleservices.com",
  timeout: 20000,
});

// Helper to map incoming query -> Smartflo query params
function buildCdrQuery(q) {
  const {
    from_date,
    to_date,
    page = 1,
    limit = 20,
    direction,         // 'inbound' | 'outbound'
    call_type,         // 'c' (answered) | 'm' (missed)
    callerid,          // customer number
    destination,       // where incoming is directed
    did_number,        // DID
    agents,            // comma-separated: "agent|<id>"
    department,        // comma-separated IDs
    ivr,               // comma-separated IDs
    duration,          // number in seconds
    operator,          // >,<,>=,<=,!=
    services,          // comma-separated
    broadcast          // "true"/"false"
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
  if (agents) params.agents = agents.split(",");          // API expects array
  if (department) params.department = department.split(",");
  if (ivr) params.ivr = ivr.split(",");
  if (duration) params.duration = duration;
  if (operator) params.operator = operator;
  if (services) params.services = services;
  if (broadcast) params.broadcast = broadcast;

  return params;
}

/**
 * GET /api/smartflo/call-records
 * Required: from_date, to_date (format: 'YYYY-MM-DD HH:mm:ss')
 * Optional: direction, call_type, callerid, destination, did_number, page, limit, etc.
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
        Authorization: token, // e.g. "Bearer <token>" OR the permanent token as given by TTBS
      },
      params,
    });

    res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({
      error: err.response?.data || err.message || "Unknown error",
    });
  }
});

router.get("/analytics", async (req, res) => {
   try {
     const token = process.env.SMARTFLO_TOKEN;
     if (!token) return res.status(500).json({ error: "SMARTFLO_TOKEN not configured" });
 
     const {
       from_date,
       to_date,
       direction,
       call_type,
       per_page = 200,
       max_pages = 25,
     } = req.query; 
 
     if (!from_date || !to_date) {
      return res.status(400).json({
        error: "from_date and to_date are required in format 'YYYY-MM-DD HH:mm:ss'",
      });
    }

    const paramsBase = {
      from_date,
      to_date,
      limit: Number(per_page) || 200,
    };
    if (direction) paramsBase.direction = direction;
    if (call_type) paramsBase.call_type = call_type;

    // Fetch multiple pages to cover the requested window
    const all = [];
    for (let page = 1; page <= Number(max_pages); page++) {
      const resp = await api.get("/v1/call/records", {
        headers: { Accept: "application/json", Authorization: token },
        params: { ...paramsBase, page },
      });
      const chunk = resp.data?.results || [];
      all.push(...chunk);
      if (chunk.length < paramsBase.limit) break; // last page
    }

    // ---- Aggregate ----
    const dailyMap = new Map();   // date -> obj
    const hourMap = new Map();    // hour(0-23) -> count
    const agentMap = new Map();   // agent -> { answered, total, duration }

    const toLower = (s) => (s || "").toString().toLowerCase();
    const num = (x) => Number(x || 0);

    for (const r of all) {
      const date = r.date || (r.start_time && String(r.start_time).slice(0, 10)) || "";
      const time = r.time || (r.start_time && String(r.start_time).slice(11, 19)) || "00:00:00";
      const hour = Math.max(0, Math.min(23, parseInt(String(time).slice(0, 2), 10) || 0));
      const dir = toLower(r.direction); // inbound | outbound
      const status = toLower(r.status); // answered|completed|missed...
      const answeredSec = num(r.answered_seconds);
      const duration = num(r.call_duration);
      const agent =
        r.agent_name ||
        r.agent_number ||
        (r.agent && (r.agent.name || r.agent.number)) ||
        "Unknown";

      const isAnswered =
        answeredSec > 0 || ["answered", "completed", "connected"].includes(status);
      const isMissed = !isAnswered;

      // daily
      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          total: 0,
          inbound: 0,
          outbound: 0,
          answered: 0,
          missed: 0,
          duration: 0,
        });
      }
      const d = dailyMap.get(date);
      d.total += 1;
      if (dir === "inbound") d.inbound += 1;
      if (dir === "outbound") d.outbound += 1;
      if (isAnswered) d.answered += 1;
      if (isMissed) d.missed += 1;
      d.duration += duration;

      // byHour
      hourMap.set(hour, (hourMap.get(hour) || 0) + 1);

      // agents
      if (!agentMap.has(agent)) {
        agentMap.set(agent, { agent, answered: 0, total: 0, duration: 0 });
      }
      const a = agentMap.get(agent);
      a.total += 1;
      if (isAnswered) a.answered += 1;
      a.duration += duration;
    }

    const daily = Array.from(dailyMap.values())
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((x) => ({
        ...x,
       avgDuration: x.total ? Math.round(x.duration / x.total) : 0,
      }));

    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: hourMap.get(h) || 0,
    }));

    const topAgents = Array.from(agentMap.values())
      .map((x) => ({
        ...x,
        avgDuration: x.total ? Math.round(x.duration / x.total) : 0,
      }))
      .sort((a, b) => b.answered - a.answered)
      .slice(0, 10);

    const summary = daily.reduce(
      (acc, d) => {
        acc.total += d.total;
        acc.inbound += d.inbound;
        acc.outbound += d.outbound;
        acc.answered += d.answered;
        acc.missed += d.missed;
        acc.duration += d.duration;
        return acc;
      },
      { total: 0, inbound: 0, outbound: 0, answered: 0, missed: 0, duration: 0 }
    );
    const avgDuration = summary.total ? Math.round(summary.duration / summary.total) : 0;

    res.json({
      summary: { ...summary, avgDuration },
      daily,
      byHour,
      topAgents,
      totalFetched: all.length,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.response?.data || err.message || "Unknown error" });
  }
});

module.exports = router;
