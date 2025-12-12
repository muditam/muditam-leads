// routes/bobotSync.js
const express = require("express");
const axios = require("axios");
const Lead = require("../models/Lead");

const router = express.Router();

const CLIENT_ID = "muditam";
const BOBOT_BASE = `https://${CLIENT_ID}.bobot.in`;

const last10 = (v = "") => String(v).replace(/\D/g, "").slice(-10);

// --------------------------------------------
// 1) STATIC AGENT MAPPING (Based on your data)
// --------------------------------------------
const AGENTS = [
  // { name: "Afrin Rifat", email: "afrin@muditam.com", id: "a682b91d-2ae7-43c1-98d3-aea0e233a156" },
  // { name: "Angel", email: "angel@muditam.com", id: "1954d237-3a0e-4f09-95bd-06aff46cb991" },
  // { name: "Asha Kaushik", email: "asha@muditam.com", id: "d460f13c-2f9d-4d69-9d3a-da0d15ecdede" },
  // { name: "Ayushi Gupta", email: "ayushi@muditam.com", id: "daece8c6-e5eb-4b48-af2b-f19fd2a30a39" },
  // { name: "Devanshi Priyanka", email: "devanshi@muditam.com", id: "aa73cd18-2fa8-407d-9879-9587ac7f01ec" },
  // { name: "Diksha Deepak", email: "diksha@muditam.com", id: "2184ce9e-7272-4efb-b845-5e494b5836a5" },
  // { name: "Kashish Chilana", email: "kashish@muditam.com", id: "487d07e5-2256-462f-a17e-4ce991d35741" },
  // { name: "Khusboo Singh", email: "khushboo@muditam.com", id: "684ecf2b-81f3-4ea7-a54d-b6658936cda1" },
  // { name: "Kiranmai", email: "Kiranmai@muditam.com", id: "5158d3c3-4345-44a7-bc4f-fb538b7b0946" },
  // { name: "Kokila", email: "kokila@muditam.com", id: "8f47b183-378c-47e7-a0df-94fd8a013bc0" },
  // { name: "Kunal Choudhary", email: "kunal@muditam.com", id: "6e0351d9-52de-45b1-be03-e4a616799e2b" },
  // { name: "kushi rameshchand", email: "kushi@muditam.com", id: "2bd5f3ed-c854-4b7a-a9a8-5d080f8d99cc" },
  // { name: "Lakshmi Ahuja", email: "lakshmi@muditam.com", id: "a77b31bf-165a-4beb-88d2-e39dfed02a42" },
  // { name: "Liza chauhan", email: "liza@muditam.com", id: "6d384c84-377b-4f6a-a791-ddd4b6e84687" },
  // { name: "Mohini Saini", email: "mohini@muditam.com", id: "52ad3cf3-2fc0-4d2e-86c4-da46e1111c7f" },
  // { name: "Mrinalini Pandey", email: "mrinalini@muditam.com", id: "f3f1f3cc-7fd2-4067-8594-f0e5f7fee59d" },
  // { name: "Nehal Joshi", email: "nehal@muditam.com", id: "854882ca-fef4-45b2-9491-b72ca3c836bb" },
  { name: "Nikita Shekhawat", email: "nikita@muditam.com", id: "4e6bc768-a3a4-4c26-b3f4-8bdeab45ad72" },
  { name: "Prachi Sharma", email: "prachi@muditam.com", id: "f188c2c2-8e68-4c65-9066-9a562ce07a9e" }
  // { name: "Sangita Rawat", email: "sangita@muditam.com", id: "62c756b2-b2e1-4055-82a5-e58c84ee26a6" },
  // { name: "Sanjana Kumari", email: "sanjana@muditam.com", id: "7178dcbb-96ef-4252-a4ab-df52a4cf4aca" },
  // { name: "Shambhavi", email: "shambhavi@muditam.com", id: "b2cd9b6d-5bca-47c0-88ab-23be81f52616" },
  // { name: "Shreya Jain", email: "shreya@muditam.com", id: "e618a93d-b2b0-4415-ad5e-d1f73fc6e3ea" },
  // { name: "Sidra Qaseem", email: "sidra@muditam.com", id: "2b63f57f-4719-4f74-9aa5-60fbde4ff9d0" },
  // { name: "Somya", email: "somya@muditam.com", id: "18ce3250-f717-4a58-aa93-71f713c8959c" },
  // { name: "Subudhi Kalyani", email: "subudhi@muditam.com", id: "5853faa8-c2f5-4a57-a57e-d4e22d099273" },
  // { name: "Sukumari", email: "sukumari@muditam.com", id: "7de41157-f99d-4c94-a451-29b10e20a377" },
  // { name: "Swati Kohli", email: "swatikohli@muditam.com", id: "dfd06a79-48ac-44fd-aa44-ea73bd72b9c8" }
];

// --------------------------------------------
// Helper: Get Agent ID by Lead Assigned Name
// --------------------------------------------
function getAgentIdByName(name) {
  if (!name) return null;
  const clean = name.trim().toLowerCase();
  const agent = AGENTS.find(a => a.name.toLowerCase() === clean);
  return agent ? agent.id : null;
}

// --------------------------------------------
// Build BoB Payload
// --------------------------------------------
function buildPayload(lead, ownerId) {
  const phone = last10(lead.contactNumber);
  return {
    name: lead.name || `Lead ${phone}`,
    identities: [
      {
        type: "primary",
        category: "phone",
        value: `+91${phone}`,
        isPrimary: true
      }
    ],
    ownerId: ownerId || undefined
  };
}

// --------------------------------------------
// Upsert Contact on BoB
// --------------------------------------------
async function upsertContact(payload) {
  const url = `${BOBOT_BASE}/contacts/create`;
  const { data } = await axios.post(url, payload);
  return data;
}

// --------------------------------------------
// SYNC CONTACTS API
// --------------------------------------------
router.post("/sync-contacts", async (req, res) => {
  try {
    const { dryRun } = req.query;
    const DRY = String(dryRun).toLowerCase() === "true";

    const leads = await Lead.find({
      contactNumber: { $exists: true, $ne: "" },
      healthExpertAssigned: { $exists: true, $ne: "" }
    })
      .sort({ _id: -1 })
      .lean();

    const results = [];

    for (const lead of leads) {
      const agentId = getAgentIdByName(lead.healthExpertAssigned);

      if (!agentId) {
        results.push({
          leadId: lead._id,
          assigned: lead.healthExpertAssigned,
          error: "No matching agent found"
        });
        continue;
      }

      const payload = buildPayload(lead, agentId);

      if (DRY) {
        results.push({ leadId: lead._id, payload });
        continue;
      }

      const resp = await upsertContact(payload);

      results.push({
        leadId: lead._id,
        assigned: lead.healthExpertAssigned,
        ownerId: agentId,
        response: resp
      });
    }

    return res.json({
      ok: true,
      total: leads.length,
      dryRun: DRY,
      results
    });

  } catch (err) {
    console.error("SYNC ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
