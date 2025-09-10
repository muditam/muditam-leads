// routes/dietTemplates.js
const express = require("express");
const DietTemplate = require("../models/DietTemplate");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const router = express.Router();

/* ---------------- Helpers (normalizers) ---------------- */
const MEALS = ["Breakfast", "Lunch", "Snacks", "Dinner"];
const FORTNIGHT_DAYS = 14;

function normalizeWeeklyBody(body) {
  if (!body || typeof body !== "object") return body;

  // Ensure fortnight exists and each meal is a 14-length string array
  const fortnight = body.fortnight || {};
  const normalizedFortnight = {};
  MEALS.forEach((meal) => {
    const arr = Array.isArray(fortnight[meal]) ? [...fortnight[meal]] : [];
    // slice/pad strictly to 14
    const fixed = arr.slice(0, FORTNIGHT_DAYS);
    while (fixed.length < FORTNIGHT_DAYS) fixed.push("");
    normalizedFortnight[meal] = fixed.map((v) => (typeof v === "string" ? v : String(v ?? "")));
  });

  // Ensure weeklyTimes exists with all meals; allow empty strings and trim
  const wt = body.weeklyTimes || {};
  const normalizedWeeklyTimes = {};
  MEALS.forEach((meal) => {
    const raw = wt[meal];
    normalizedWeeklyTimes[meal] = (typeof raw === "string" ? raw : "").trim();
  });

  return {
    ...body,
    fortnight: normalizedFortnight,
    weeklyTimes: normalizedWeeklyTimes,
  };
}

/* ---------------- JSON Schemas ---------------- */
const weekly14Schema = {
  $id: "weekly-14",
  type: "object",
  required: ["fortnight", "weeklyTimes"],
  properties: {
    fortnight: {
      type: "object",
      required: MEALS,
      properties: MEALS.reduce((p, meal) => {
        p[meal] = {
          type: "array",
          minItems: FORTNIGHT_DAYS,
          maxItems: FORTNIGHT_DAYS,
          items: { type: "string" },
        };
        return p;
      }, {}),
      additionalProperties: false,
    },
    weeklyTimes: {
      type: "object",
      required: MEALS,
      properties: {
        // minLength: 0 means empty string is allowed (UI may keep it blank)
        Breakfast: { type: "string", minLength: 0 },
        Lunch: { type: "string", minLength: 0 },
        Snacks: { type: "string", minLength: 0 },
        Dinner: { type: "string", minLength: 0 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

function slotSchema() {
  return {
    type: "object",
    required: ["title", "time", "options"],
    properties: {
      title: { type: "string", minLength: 1 },
      time: { type: "string", minLength: 1 },
      options: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
    },
    additionalProperties: false,
  };
}

const monthlyOptionsSchema = {
  $id: "monthly-options",
  type: "object",
  required: ["monthly"],
  properties: {
    monthly: {
      type: "object",
      required: ["Breakfast", "Lunch", "Evening Snack", "Dinner"],
      properties: {
        Breakfast: slotSchema(),
        // You can keep Mid-Morning Snack as optional, or remove this line if unused:
        "Mid-Morning Snack": slotSchema(),
        Lunch: slotSchema(),
        "Evening Snack": slotSchema(),
        Dinner: slotSchema(),
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/* ---------------- Ajv Setup ---------------- */
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {
  "weekly-14": ajv.compile(weekly14Schema),
  "monthly-options": ajv.compile(monthlyOptionsSchema),
};

function validateBody(type, body) {
  const validate = validators[type];
  if (!validate) {
    const err = new Error(`Unsupported template type: ${type}`);
    err.status = 400;
    throw err;
  }
  const ok = validate(body);
  if (!ok) {
    const msg = validate.errors?.map(e => `${e.instancePath || "body"} ${e.message}`).join("; ");
    const err = new Error(msg || "Validation failed");
    err.status = 400;
    throw err;
  }
}

/* ---------------- Routes ---------------- */

// GET all templates (optionally filter by type/status)
router.get("/", async (req, res) => {
  const { type, status } = req.query;
  const q = {};
  if (type) q.type = type;
  if (status) q.status = status;
  const docs = await DietTemplate.find(q).sort({ updatedAt: -1 }).lean();
  res.json(docs);
});

// GET one template
router.get("/:id", async (req, res) => {
  const doc = await DietTemplate.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
});

// CREATE template
router.post("/", async (req, res) => {
  try {
    const { name, type, category, tags, status } = req.body;
    let { body } = req.body;

    if (!name || !type || !body) {
      return res.status(400).json({ error: "name, type, body are required" });
    }

    // Backfill/normalize weekly body (keeps older clients safe)
    if (type === "weekly-14") {
      body = normalizeWeeklyBody(body);
    }

    validateBody(type, body);

    const doc = await DietTemplate.create({
      name: name.trim(),
      type,
      category: category || null,
      tags: Array.isArray(tags) ? tags : [],
      status: status || "draft",
      version: 1,
      body,
      createdBy: req.user?.email || "system",
      updatedBy: req.user?.email || "system",
    });

    res.json(doc);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Failed to create template" });
  }
});

// UPDATE template
router.put("/:id", async (req, res) => {
  try {
    const { name, category, tags, status, type } = req.body;
    let { body } = req.body;

    const doc = await DietTemplate.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    // Allow type change (rare)
    if (typeof type === "string" && type !== doc.type) {
      doc.type = type;
    }

    // If a new body is provided, normalize & validate it
    if (body) {
      if (doc.type === "weekly-14") {
        body = normalizeWeeklyBody(body);
      }
      validateBody(doc.type, body);
      doc.body = body;
    }

    if (name) doc.name = name.trim();
    if (category !== undefined) doc.category = category;
    if (tags !== undefined) doc.tags = Array.isArray(tags) ? tags : [];
    if (status) doc.status = status;

    doc.version = (doc.version || 1) + 1;
    doc.updatedBy = req.user?.email || "system";

    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Failed to update template" });
  }
});

// UPDATE status only
router.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["draft", "published", "archived"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const doc = await DietTemplate.findByIdAndUpdate(
    req.params.id,
    { status, $inc: { version: 1 }, updatedBy: req.user?.email || "system" },
    { new: true }
  );
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
});

// DELETE template
router.delete("/:id", async (req, res) => {
  try {
    const doc = await DietTemplate.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, deletedId: doc._id });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete template" });
  }
});

module.exports = router;
