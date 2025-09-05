// routes/dietTemplates.js
const express = require("express");
const DietTemplate = require("../models/DietTemplate");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const router = express.Router();

/* ---------------- JSON Schemas ---------------- */
const weekly14Schema = {
  $id: "weekly-14",
  type: "object",
  required: ["fortnight"],
  properties: {
    fortnight: {
      type: "object",
      required: ["Breakfast", "Lunch", "Snacks", "Dinner"],
      properties: ["Breakfast", "Lunch", "Snacks", "Dinner"].reduce((p, meal) => {
        p[meal] = {
          type: "array",
          minItems: 14,
          maxItems: 14,
          items: { type: "string" },
        };
        return p;
      }, {}),
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
      required: ["Breakfast", "Mid-Morning Snack", "Lunch", "Evening Snack", "Dinner"],
      properties: {
        Breakfast: slotSchema(),
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
    const { name, type, category, tags, status, body } = req.body;
    if (!name || !type || !body) {
      return res.status(400).json({ error: "name, type, body are required" });
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
    const { name, category, tags, status, body, type } = req.body;
    const doc = await DietTemplate.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    if (typeof type === "string" && type !== doc.type) doc.type = type;
    if (body) validateBody(doc.type, body);

    if (name) doc.name = name.trim();
    if (category !== undefined) doc.category = category;
    if (tags !== undefined) doc.tags = Array.isArray(tags) ? tags : [];
    if (status) doc.status = status;
    if (body) doc.body = body;

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

module.exports = router;
