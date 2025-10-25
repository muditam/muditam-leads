// routes/bobotSync.js
const express = require("express");
const axios = require("axios");
const Lead = require("../models/Lead");

const router = express.Router();
 
const CLIENT_ID = "muditam";
const BOBOT_BASE = `https://${CLIENT_ID}.bobot.in`;

const last10 = (v = "") => String(v).replace(/\D/g, "").slice(-10);
const eqCI = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
 
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
          .then((res) => { results[idx] = res; })
          .catch((err) => { results[idx] = { error: err }; })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}
 
async function getAgents() {
  const url = `${BOBOT_BASE}/chat/agents?all=true&online=false&type=false`;
  const res = await axios.get(url);
  const payload = res?.data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}
 
function extractFromAttributes(obj, key) {
  const fromAA = obj?.agentAttributes?.[key];
  if (fromAA) return fromAA;
  const arr = Array.isArray(obj?.Attributes) ? obj.Attributes : [];
  const hit = arr.find(x => x?.Name === key);
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
 
function pickAgentsById(agentsRaw) {
  const agents = agentsRaw.map(normalizeAgent);

  const byEmail = Object.fromEntries(
    agents.filter(a => a.email).map(a => [a.email.toLowerCase(), a])
  );

  let mrinalini = byEmail["mrinalini@muditam.com"] || null;
  let shreya    = byEmail["shreya@muditam.com"]    || null;

  if (!mrinalini) mrinalini = agents.find(a => /mrinalini/i.test(a.name)) || null;
  if (!shreya)    shreya    = agents.find(a => /shreya/i.test(a.name))    || null;

  mrinalini = mrinalini ? { id: mrinalini.id, name: "Mrinalini Pandey" } : null;
  shreya    = shreya    ? { id: shreya.id,    name: "Shreya Jain" }      : null;

  return { mrinalini, shreya, _debugAgents: agents };
}
 
async function getTagIdsByNames(tagNames = []) {
  if (!tagNames.length) return {};
  const out = {};
  for (const name of tagNames) {
    const url = `${BOBOT_BASE}/contacts-tag-definitions?search=${encodeURIComponent(name)}`;
    try {
      const { data } = await axios.get(url);
      const list = Array.isArray(data?.data) ? data.data : [];
      const match = list.find(t => eqCI(t.name, name)) || list[0];
      if (match?.id) out[name] = match.id;
    } catch (err) {
      console.error(`[BoB] Tag lookup failed for "${name}":`, err.response?.data || err.message);
    }
  }
  return out;
}
 
function buildPayload(lead, ownerId, tagIds = []) {
  const phone = last10(lead.contactNumber);
  const payload = {
    name: lead.name || `Lead ${phone}`,
    identities: [
      { type: "primary", category: "phone", value: `+91${phone}`, isPrimary: true }
    ],
  };
  if (ownerId) payload.ownerId = ownerId;
  if (tagIds.length) payload.tagIds = tagIds;
  return payload;
}
 
async function upsertContact(payload) {
  const url = `${BOBOT_BASE}/contacts/create`;
  const { data } = await axios.post(url, payload);
  return data;
}

 
router.post("/sync-contacts", async (req, res) => {
  try {
    const { limit: limitRaw, dryRun: dryRaw, tags: tagsRaw, concurrency: concRaw } = req.query;
    const limit       = Math.max(1, Number(limitRaw || 200));
    const dryRun      = String(dryRaw || "").toLowerCase() === "true";
    const CONCURRENCY = Math.max(1, Number(concRaw || 5));
 
    const agentsRaw = await getAgents();
    const { mrinalini, shreya, _debugAgents } = pickAgentsById(agentsRaw);

    if (!mrinalini && !shreya) {
      const sample = _debugAgents.slice(0, 5).map(a => ({ id: a.id, email: a.email, name: a.name }));
      return res.status(400).json({
        error: "Could not find Mrinalini or Shreya in /chat/agents",
        hint: "Email may be nested or cased differently; we now check agentAttributes/Attributes/name as well.",
        sample
      });
    }
 
    const tagNamesInput = (tagsRaw || "").split(",").map(s => s.trim()).filter(Boolean);
    const tagMap = await getTagIdsByNames(tagNamesInput);
    const tagIds = Object.values(tagMap);
 
    const leads = await Lead.find({
      contactNumber: { $exists: true, $ne: "" },
      healthExpertAssigned: { $in: ["Mrinalini Pandey", "Shreya Jain"] },
    })
      .sort({ _id: -1 })
      .limit(limit)
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
 
        const ownerId =
          lead.healthExpertAssigned === "Mrinalini Pandey" ? mrinalini?.id :
          lead.healthExpertAssigned === "Shreya Jain"       ? shreya?.id    :
          null;

        const payload = buildPayload(lead, ownerId, tagIds);

        if (dryRun) {
          results.push({ leadId: lead._id, dryRun: true, payload });
          return;
        }

        const resp = await upsertContact(payload);
        const msg = String(resp?.message || "").toLowerCase();

        if (msg.includes("already exists")) summary.exists++;
        else if (msg.includes("owner updated") || msg.includes("added")) summary.updated++;
        else if (resp?.success) summary.created++;
        else summary.created++;  

        results.push({ leadId: lead._id, phone: `+91${phone}`, ownerId, response: resp });
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
