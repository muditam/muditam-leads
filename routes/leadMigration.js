// routes/leadsMigration.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Lead = require('../models/Lead');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanLabel = (s) => (s || '').trim().replace(/\s+/g, ' ');
const normKey = (s) => cleanLabel(s).toLocaleLowerCase();

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

router.get('/experts/:expert/leads', async (req, res) => {
  try {
    const { expert } = req.params;
    const { q = '', limit, onlyActive } = req.query;
    const label = cleanLabel(expert);
    const rx = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, 'i');

    const find = { healthExpertAssigned: rx };

    if (q) {
      const qrx = new RegExp(q, 'i');
      find.$or = [{ name: qrx }, { contactNumber: qrx }];
    }

    // ⬇️ Active OR unset (null/empty/missing)
    if (String(onlyActive) === '1' || String(onlyActive).toLowerCase() === 'true') {
      // If a search "q" was set above, it created find.$or; so we must AND this status filter.
      // Move the prior OR into an $and with the status conditions.
      const prevOr = find.$or;
      delete find.$or;

      const statusOr = [
        { retentionStatus: { $regex: /^\s*active\s*$/i } },
        { retentionStatus: null },
        { retentionStatus: '' },
        { retentionStatus: { $exists: false } },
      ];

      if (prevOr) {
        // both search OR and status OR should be true → use $and
        Object.assign(find, {
          $and: [
            { $or: prevOr },
            { $or: statusOr }
          ]
        });
      } else {
        Object.assign(find, { $or: statusOr });
      }
    }

    const projection = {
      _id: 1,
      name: 1,
      contactNumber: 1,
      healthExpertAssigned: 1,
      retentionStatus: 1,
    };

    let queryM = Lead.find(find, projection).sort({ name: 1, _id: 1 });

    const lim = Number(limit);
    if (Number.isFinite(lim) && lim > 0) {
      queryM = queryM.limit(lim);
    }

    const items = await queryM.exec();
    res.json({ total: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
