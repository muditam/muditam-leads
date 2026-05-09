const express = require("express");
const requireSession = require("../middleware/requireSession");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const {
  enqueueContact,
  runFullSync,
  getFailures,
  getStatusSummary,
  normalizeIndianE164,
} = require("../services/zoomContactSyncService");

const router = express.Router();

const ADMIN_ROLES = new Set(["manager", "admin", "super admin", "super-admin", "developer"]);
function isAdminLike(role = "") {
  return ADMIN_ROLES.has(String(role || "").toLowerCase());
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

async function getUnifiedContacts(limit = 5000) {
  const [leads, customers] = await Promise.all([
    Lead.find({}, { name: 1, contactNumber: 1, updatedAt: 1, createdAt: 1 }).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean(),
    Customer.find({}, { name: 1, phone: 1, updatedAt: 1, createdAt: 1 }).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean(),
  ]);

  const merged = [
    ...leads.map((x) => ({ name: x?.name || "", phone: x?.contactNumber || "", source: "Lead" })),
    ...customers.map((x) => ({ name: x?.name || "", phone: x?.phone || "", source: "Customer" })),
  ];

  const byPhone = new Map();
  for (const row of merged) {
    const phoneE164 = normalizeIndianE164(row.phone);
    if (!phoneE164) continue;
    const name = String(row.name || "").trim() || "Unknown";
    if (!byPhone.has(phoneE164)) {
      byPhone.set(phoneE164, { name, phoneE164, source: row.source });
      continue;
    }
    const prev = byPhone.get(phoneE164);
    if ((prev.name || "").toLowerCase() === "unknown" && name.toLowerCase() !== "unknown") {
      byPhone.set(phoneE164, { name, phoneE164, source: row.source });
    }
  }

  return Array.from(byPhone.values()).sort((a, b) => a.name.localeCompare(b.name));
}

router.get("/preview", requireSession, async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 50)));
    const all = await getUnifiedContacts(10000);
    res.json({
      ok: true,
      total: all.length,
      items: all.slice(0, limit),
      note: "Use /api/zoom/contacts/export.csv to download import-ready CSV for Zoom contacts.",
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || "Failed to prepare contacts." });
  }
});

router.get("/export.csv", requireSession, async (_req, res) => {
  try {
    const contacts = await getUnifiedContacts(50000);
    const header = ["Name", "Phone Number", "Company", "Notes"];
    const rows = contacts.map((c) => [c.name, c.phoneE164, "Muditam", `Source: ${c.source}`]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvEscape).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="zoom-contacts-${Date.now()}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || "CSV export failed." });
  }
});

router.get("/sync/status", requireSession, async (req, res) => {
  if (!isAdminLike(req.sessionUser?.role || "")) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const status = await getStatusSummary();
  return res.json({ ok: true, ...status });
});

router.get("/sync/failures", requireSession, async (req, res) => {
  if (!isAdminLike(req.sessionUser?.role || "")) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const rows = await getFailures(limit);
  return res.json({ ok: true, total: rows.length, rows });
});

router.post("/sync/reconcile-now", requireSession, async (req, res) => {
  if (!isAdminLike(req.sessionUser?.role || "")) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const out = await runFullSync();
  return res.json(out);
});

router.post("/sync/enqueue", requireSession, async (req, res) => {
  const name = String(req.body?.name || "").trim() || "Unknown";
  const phone = String(req.body?.phone || "").trim();
  const source = String(req.body?.source || "Manual");
  const normalized = normalizeIndianE164(phone);
  if (!normalized) return res.status(400).json({ ok: false, message: "Invalid phone" });
  const queued = enqueueContact({ name, phone: normalized, source });
  return res.json({ ok: true, queued, phone: normalized });
});

module.exports = router;
