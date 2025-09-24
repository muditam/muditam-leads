// routes/leadsMigration.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Lead = require('../models/Lead');

// helpers (same as before)
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanLabel = (s) => (s || '').trim().replace(/\s+/g, ' ');
const normKey = (s) => cleanLabel(s).toLocaleLowerCase();

// 1) Distinct experts (deduped)
router.get('/experts', async (req, res) => {
  try {
    const raw = await Lead.distinct('healthExpertAssigned', {
      healthExpertAssigned: { $exists: true, $ne: null, $ne: '' }
    });

    const map = new Map();
    for (const v of raw) {
      const label = cleanLabel(v);
      if (!label) continue;
      const key = normKey(label);
      if (!map.has(key)) map.set(key, label);
    }
    const experts = Array.from(map.values()).sort((a, b) => a.localeCompare(b));
    res.json({ experts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2) Leads for a selected expert — now **no default limit**
router.get('/experts/:expert/leads', async (req, res) => {
  try {
    const { expert } = req.params;
    const { q = '', limit } = req.query; 
    const label = cleanLabel(expert);
    const rx = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, 'i');

    const find = { healthExpertAssigned: rx };
    if (q) {
      const qrx = new RegExp(q, 'i');
      find.$or = [{ name: qrx }, { contactNumber: qrx }];
    }

    const projection = {
      _id: 1,
      name: 1,
      contactNumber: 1,
      healthExpertAssigned: 1,
    };

    let queryM = Lead.find(find, projection).sort({ name: 1, _id: 1 });

    // Apply limit ONLY if provided and > 0. If not provided or invalid → no limit.
    const lim = Number(limit);
    if (Number.isFinite(lim) && lim > 0) {
      queryM = queryM.limit(lim);
    } // else leave unlimited

    const items = await queryM.exec();
    res.json({ total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3) Migrate selected
router.post('/migrate', async (req, res) => {
  try {
    const { leadIds = [], toExpert } = req.body;

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'Provide leadIds (array of _id strings).' });
    }
    const toLabel = cleanLabel(toExpert);
    if (!toLabel) {
      return res.status(400).json({ error: 'Provide toExpert (non-empty string).' });
    }

    const ids = leadIds.filter(Boolean).map((id) => new mongoose.Types.ObjectId(id));

    const result = await Lead.updateMany(
      { _id: { $in: ids } },
      { $set: { healthExpertAssigned: toLabel } }
    );

    res.json({
      ok: true,
      matched: result.matchedCount ?? result.nMatched,
      modified: result.modifiedCount ?? result.nModified,
      toExpert: toLabel,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
