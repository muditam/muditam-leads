// routes/bobotSync.js
const express = require("express");
const axios = require("axios");
const Lead = require("../models/Lead");

const router = express.Router();

const CLIENT_ID = "muditam";
const BOBOT_BASE = `https://${CLIENT_ID}.bobot.in`;

const last10 = (v = "") => String(v).replace(/\D/g, "").slice(-10);
const eqCI = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

/** Simple async pool without external deps */
async function asyncPool(concurrency, items, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < concurrency && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve()
          .then(() => worker(items[idx], idx))
          .then((res) => (results[idx] = res))
          .catch((err) => (results[idx] = { error: err }))
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

/** 1) Fetch agents from BoBot */
async function getAgents() {
  const url = `${BOBOT_BASE}/chat/agents?all=true&online=false&type=false`;
  const res = await axios.get(url);
  const payload = res?.data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

/** Helpers to normalize agent shape */
function extractFromAttributes(obj, key) {
  const fromAA = obj?.agentAttributes?.[key];
  if (fromAA) return fromAA;
  const arr = Array.isArray(obj?.Attributes) ? obj.Attributes : [];
  const hit = arr.find((x) => x?.Name === key);
  return hit?.Value;
}

function normalizeAgent(a = {}) {
  const id =
    a.id ||
    extractFromAttributes(a, "custom:agent_id") ||
    a.Username ||
    extractFromAttributes(a, "custom:sub");

  let email =
    (a.email || "").trim() ||
    (extractFromAttributes(a, "email") || "").trim() ||
    (a.name || "").trim();

  email = /@/.test(email) ? email.toLowerCase() : "";
  const name = a.name || email || a.Username || id || "";
  return { id, email, name, raw: a };
}

/** 2) Identify Kushi & Sakshi */
function pickAgentsById(agentsRaw) {
  const agents = agentsRaw.map(normalizeAgent);
  const byEmail = Object.fromEntries(
    agents.filter((a) => a.email).map((a) => [a.email.toLowerCase(), a])
  );

  // target emails (lowercased)
  let kushi  = byEmail["kushi@muditam.com"] || null;
  let sakshi = byEmail["sakshikambli@muditam.com"] || null;

  // fallback by display name if emails mismatch in source
  if (!kushi)  kushi  = agents.find((a) => /(kushi(\s+ramesh(chand)?)?)/i.test(a.name)) || null;
  if (!sakshi) sakshi = agents.find((a) => /(sakshi(\s+kambli)?)/i.test(a.name)) || null;

  kushi  = kushi  ? { id: kushi.id,  name: "Kushi Ramesh" }  : null;
  sakshi = sakshi ? { id: sakshi.id, name: "Sakshi kambli" } : null;

  return { kushi, sakshi, _debugAgents: agents };
}

/** 3) Optional tag lookup for ?tags= in query (by tag *name* on BoB) */
async function getTagIdsByNames(tagNames = []) {
  if (!tagNames.length) return {};
  const out = {};
  for (const name of tagNames) {
    const url = `${BOBOT_BASE}/contacts-tag-definitions?search=${encodeURIComponent(name)}`;
    try {
      const { data } = await axios.get(url);
      const list = Array.isArray(data?.data) ? data.data : [];
      const match = list.find((t) => eqCI(t.name, name)) || list[0];
      if (match?.id) out[name] = match.id;
    } catch (err) {
      console.error(`[BoB] Tag lookup failed for "${name}":`, err.message);
    }
  }
  return out;
}

/** 3.1) Hardcoded expert tag IDs (as provided) */
const TAG_ID_KUSHI  = "49faa8f4-2ddc-4335-b8e5-d051af92e04d"; // Kushi Ramesh
const TAG_ID_SAKSHI = "d93ba687-2dc4-4586-b8c0-4f8f91e5be20"; // Sakshi kambli

/** 4) Build payload for contact create/upsert */
function buildPayload(lead, ownerId, tagIds = []) {
  const phone = last10(lead.contactNumber);
  const payload = {
    name: lead.name || `Lead ${phone}`,
    identities: [
      { type: "primary", category: "phone", value: `+91${phone}`, isPrimary: true },
    ],
  };
  if (ownerId) payload.ownerId = ownerId;
  if (tagIds.length) payload.tagIds = tagIds;
  return payload;
}

/** 5) Upsert contact on BoBot */
async function upsertContact(payload) {
  const url = `${BOBOT_BASE}/contacts/create`;
  const { data } = await axios.post(url, payload);
  return data;
}

/** 6) Main sync route */
router.post("/sync-contacts", async (req, res) => {
  try {
    const { dryRun: dryRaw, tags: tagsRaw, concurrency: concRaw } = req.query;
    const dryRun = String(dryRaw || "").toLowerCase() === "true";
    const CONCURRENCY = Math.max(1, Number(concRaw || 5));

    // a) agents
    const agentsRaw = await getAgents();
    const { kushi, sakshi, _debugAgents } = pickAgentsById(agentsRaw);

    if (!kushi && !sakshi) {
      const sample = _debugAgents.slice(0, 5).map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
      }));
      return res.status(400).json({
        error: "Could not find Kushi Ramesh or Sakshi kambli in /chat/agents",
        sample,
      });
    }

    // b) optional extra tags from query string (?tags=VIP,Priority)
    const tagNamesInput = (tagsRaw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tagMap = await getTagIdsByNames(tagNamesInput);
    const extraTagIds = Object.values(tagMap);

    // c) fetch leads for these experts (match EXACT names saved in Lead.healthExpertAssigned)
    const leads = await Lead.find({
      contactNumber: { $exists: true, $ne: "" },
      healthExpertAssigned: { $in: ["Kushi Ramesh", "Sakshi kambli"] },
    })
      .sort({ _id: -1 })
      .lean();

    if (!leads.length) {
      return res.json({ ok: true, message: "No matching leads found", processed: 0 });
    }

    const summary = { created: 0, exists: 0, updated: 0, failed: 0 };
    const results = [];

    await asyncPool(CONCURRENCY, leads, async (lead) => {
      try {
        const phone = last10(lead.contactNumber);
        if (!phone) {
          results.push({ leadId: lead._id, skipped: true, reason: "No valid phone" });
          return;
        }

        // d) owner + expert tag
        const ownerId =
          lead.healthExpertAssigned === "Kushi Ramesh"
            ? kushi?.id
            : lead.healthExpertAssigned === "Sakshi kambli"
            ? sakshi?.id
            : null;

        const finalTagIds = [...extraTagIds];
        if (lead.healthExpertAssigned === "Kushi Ramesh") {
          finalTagIds.push(TAG_ID_KUSHI);
        } else if (lead.healthExpertAssigned === "Sakshi kambli") {
          finalTagIds.push(TAG_ID_SAKSHI);
        }

        const payload = buildPayload(lead, ownerId, finalTagIds);

        if (dryRun) {   
          results.push({ leadId: lead._id, dryRun: true, payload });
          return;
        }

        // e) call BoBot
        const resp = await upsertContact(payload);
        const msg = String(resp?.message || "").toLowerCase();

        if (msg.includes("already exists")) summary.exists++;
        else if (msg.includes("owner updated") || msg.includes("added")) summary.updated++;
        else if (resp?.success) summary.created++;
        else summary.created++; // fallback

        results.push({
          leadId: lead._id,
          phone: `+91${phone}`,
          ownerId,
          response: resp,
        }); 
      } catch (err) {
        summary.failed++;
        results.push({ leadId: lead._id, error: err.response?.data || err.message });
      }
    });

    res.json({
      ok: true,
      total: leads.length,
      dryRun,
      concurrency: CONCURRENCY,
      tagNames: tagNamesInput,
      tagIdsResolved: tagMap, 
      summary,
      results,
    });
  } catch (err) {
    console.error("[bobot sync] error:", err);
    res.status(500).json({ error: "Sync failed", details: err.message });
  }
});

module.exports = router;
 