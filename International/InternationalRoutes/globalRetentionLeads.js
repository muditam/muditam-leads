// routes/globalRetentionLeads.js
const express = require("express");
const router = express.Router();
const GlobalRetentionLead = require("../InternationalModel/GlobalRetentionLead");

// helper: compute "days ago" from a Date
function daysFromNow(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// helper: build followup filter clause from query value
function buildFollowupFilterClause(filterKey) {
  const key = String(filterKey || "").toLowerCase().trim();
  if (!key || key === "all") return {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startOfToday = new Date(today);
  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);

  const startOfTomorrow = new Date(today);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const endOfTomorrow = new Date(startOfTomorrow);
  endOfTomorrow.setHours(23, 59, 59, 999);

  const startOfLater = new Date(today);
  startOfLater.setDate(startOfLater.getDate() + 2);

  if (key === "today") {
    return {
      nextFollowup: {
        $gte: startOfToday,
        $lte: endOfToday,
      },
    };
  }

  if (key === "tomorrow") {
    return {
      nextFollowup: {
        $gte: startOfTomorrow,
        $lte: endOfTomorrow,
      },
    };
  }

  if (key === "later") {
    return {
      nextFollowup: {
        $gte: startOfLater,
      },
    };
  }

  if (key === "missed") {
    return {
      nextFollowup: {
        $lt: startOfToday,
      },
    };
  }

  if (key === "notset" || key === "not set") {
    return {
      $or: [{ nextFollowup: { $exists: false } }, { nextFollowup: null }],
    };
  }

  return {};
}

// GET /api/global-retention-leads
// query: page, limit, search, status (all/active/lost), followupFilter
router.get("/", async (req, res) => {
  try {
    let {
      page = 1,
      limit = 20,
      search = "",
      status,
      followupFilter,
    } = req.query;

    page = Math.max(parseInt(page, 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

    const filter = {};

    // status filter (Active / Lost)
    const statusKey = String(status || "").toLowerCase().trim();
    if (statusKey === "active") {
      filter.$or = [{ retentionStatus: /active/i }, { status: /active/i }];
    } else if (statusKey === "lost") {
      filter.$or = [{ retentionStatus: /lost/i }, { status: /lost/i }];
    }

    // search filter (name / phone)
    if (search && search.trim()) {
      const s = search.trim();
      const regex = new RegExp(s, "i");
      filter.$and = (filter.$and || []).concat([
        {
          $or: [
            { name: regex },
            { fullName: regex },
            { phoneNumber: regex },
            { contactNumber: regex },
          ],
        },
      ]);
    }

    // followup filter
    const followupClause = buildFollowupFilterClause(followupFilter);
    if (Object.keys(followupClause).length > 0) {
      filter.$and = (filter.$and || []).concat([followupClause]);
    }

    const skip = (page - 1) * limit;

    const [totalCount, docs] = await Promise.all([
      GlobalRetentionLead.countDocuments(filter),
      GlobalRetentionLead.find(filter)
        .sort({ updatedAt: -1 }) // latest updated first
        .skip(skip)
        .limit(limit),
    ]);

    const leads = docs.map((doc) => {
      const obj = doc.toObject({ virtuals: true });
      obj.lastOrderDays = daysFromNow(obj.lastOrderAt);
      obj.lastReachedDays = daysFromNow(obj.lastReachedAt);
      return obj;
    });

    res.json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      leads,
    });
  } catch (err) {
    console.error("GET /api/global-retention-leads error:", err);
    res
      .status(500)
      .json({ message: "Failed to load global retention leads." });
  }
});

// POST /api/global-retention-leads
// body: { name, phoneNumber, age, lookingFor, globalRetentionDetails? }
router.post("/", async (req, res) => {
  try {
    const {
      name,
      phoneNumber,
      age,
      lookingFor,
      globalRetentionDetails,
    } = req.body || {};

    if (!name || !phoneNumber) {
      return res
        .status(400)
        .json({ message: "Name and phoneNumber are required." });
    }

    const trimmedName = String(name).trim();
    const trimmedPhone = String(phoneNumber).trim();
    const trimmedLookingFor = (lookingFor || "").trim();

    const update = {
      name: trimmedName,
      fullName: trimmedName,
      phoneNumber: trimmedPhone,
      contactNumber: trimmedPhone,
      age: age ? Number(age) : undefined,
      lookingFor: trimmedLookingFor,
      condition: trimmedLookingFor,
    };

    // if frontend sends full retention details while creating
    if (
      globalRetentionDetails &&
      typeof globalRetentionDetails === "object"
    ) {
      update.globalRetentionDetails = globalRetentionDetails;
    }

    // upsert by phoneNumber so duplicates aren't created
    const saved = await GlobalRetentionLead.findOneAndUpdate(
      { phoneNumber: trimmedPhone },
      {
        $setOnInsert: {
          phoneNumber: trimmedPhone,
          contactNumber: trimmedPhone,
        },
        $set: update,
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    const obj = saved.toObject({ virtuals: true });
    obj.lastOrderDays = daysFromNow(obj.lastOrderAt);
    obj.lastReachedDays = daysFromNow(obj.lastReachedAt);

    res.status(201).json({
      message: "Global retention lead saved successfully.",
      lead: obj,
    });
  } catch (err) {
    console.error("POST /api/global-retention-leads error:", err);
    res
      .status(500)
      .json({ message: "Failed to create global retention lead." });
  }
});

// PATCH /api/global-retention-leads/:id
// Used by header fields + GlobalRetentionDetails form
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const updatableFields = [
      "nextFollowup",
      "retentionStatus",
      "followupStatus",
      "prefMethod",
      "condition",
      "lookingFor",
      "lastOrderAt",
      "lastReachedAt",
      "followupTag",
      // 🔹 allow full structured medical/lifestyle fields
      "globalRetentionDetails",
    ];

    const update = {};
    updatableFields.forEach((f) => {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        update[f] = req.body[f];
      }
    });

    // handle nextFollowup as Date
    if (Object.prototype.hasOwnProperty.call(update, "nextFollowup")) {
      if (!update.nextFollowup) {
        update.nextFollowup = null;
      } else {
        const d = new Date(update.nextFollowup);
        update.nextFollowup = Number.isNaN(d.getTime()) ? null : d;
      }
    }

    // handle lastOrderAt / lastReachedAt as Date if ever sent
    ["lastOrderAt", "lastReachedAt"].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(update, field)) {
        if (!update[field]) {
          update[field] = null;
        } else {
          const d = new Date(update[field]);
          update[field] = Number.isNaN(d.getTime()) ? null : d;
        }
      }
    });

    const lead = await GlobalRetentionLead.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    if (!lead) {
      return res.status(404).json({ message: "Lead not found." });
    }

    const obj = lead.toObject({ virtuals: true });
    obj.lastOrderDays = daysFromNow(obj.lastOrderAt);
    obj.lastReachedDays = daysFromNow(obj.lastReachedAt);

    res.json({
      message: "Global retention lead updated.",
      lead: obj,
    });
  } catch (err) {
    console.error("PATCH /api/global-retention-leads/:id error:", err);
    res
      .status(500)
      .json({ message: "Failed to update global retention lead." });
  }
});

module.exports = router;
