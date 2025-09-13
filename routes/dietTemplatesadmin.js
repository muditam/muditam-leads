// routes/dietTemplates.js
const express = require("express");
const mongoose = require("mongoose");
const DietTemplate = require("../models/DietTemplate");
const DietPlan = require("../models/DietPlan");
const Employee = require("../models/Employee");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const router = express.Router();

/* ---------------- Helpers (normalizers) ---------------- */
const MEALS = ["Breakfast", "Lunch", "Snacks", "Dinner"];
const FORTNIGHT_DAYS = 14;

function normalizeWeeklyBody(body) {
  if (!body || typeof body !== "object") return body;

  const fortnight = body.fortnight || {};
  const normalizedFortnight = {};
  MEALS.forEach((meal) => {
    const arr = Array.isArray(fortnight[meal]) ? [...fortnight[meal]] : [];
    const fixed = arr.slice(0, FORTNIGHT_DAYS);
    while (fixed.length < FORTNIGHT_DAYS) fixed.push("");
    normalizedFortnight[meal] = fixed.map((v) => (typeof v === "string" ? v : String(v ?? "")));
  });

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

/* ---------------- Employee name resolver ---------------- */
function isBogusName(v) {
  if (typeof v !== "string") return false;
  const low = v.trim().toLowerCase();
  return ["system", "admin", "root", "muditam"].includes(low);
}

async function resolveEmployeeFullName({ clientValue, reqUser }) {
  // If client sent a non-empty string and it's not an email, assume full name
  if (typeof clientValue === "string" && clientValue.trim()) {
    const v = clientValue.trim();
    if (isBogusName(v)) return "";
    if (v.includes("@")) {
      const emp = await Employee.findOne({ email: v }).lean();
      return emp?.fullName || ""; // no email fallback
    }
    return v; // full name from client
  }

  // Try req.user if available
  if (reqUser?.fullName && !isBogusName(reqUser.fullName)) return reqUser.fullName;

  if (reqUser?.email) {
    const emp = await Employee.findOne({ email: reqUser.email }).lean();
    return emp?.fullName || "";
  }

  if (reqUser?.id && mongoose.Types.ObjectId.isValid(reqUser.id)) {
    const emp = await Employee.findById(reqUser.id).lean();
    if (emp?.fullName && !isBogusName(emp.fullName)) return emp.fullName;
  }

  return ""; // final fallback: show nothing rather than "system"
}

/* ---------------- Routes ---------------- */

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

// CREATE diet plan
router.post('/', async (req, res) => {
  try {
    const { customer = {}, plan = {}, createdBy: createdByFromClient } = req.body;

    // Grab from plan OR top-level as fallback
    const conditions = Array.isArray(plan.conditions) ? plan.conditions : req.body.conditions;
    const healthGoals = Array.isArray(plan.healthGoals) ? plan.healthGoals : req.body.healthGoals;
    const healthProfile = plan.healthProfile ?? req.body.healthProfile;

    const createdBy = await resolveEmployeeFullName({
      clientValue: createdByFromClient,
      reqUser: req.user,
    });

    const doc = await DietPlan.create({
      customer,
      planType: plan.planType,
      templateId: plan.templateId,
      templateLabel: plan.templateLabel,
      templateType: plan.templateType,
      startDate: plan.startDate,
      durationDays: plan.durationDays,
      ...(plan.planType === 'Weekly'
        ? { fortnight: plan.fortnight, weeklyTimes: plan.weeklyTimes }
        : { monthly: plan.monthly }),
      healthProfile: healthProfile || {},
      conditions: Array.isArray(conditions) ? conditions : [],
      healthGoals: Array.isArray(healthGoals) ? healthGoals : [],
      notes: plan.notes || '',
      createdBy,
    });

    res.json(doc);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to create diet plan' });
  }
});

// UPDATE template
router.put("/:id", async (req, res) => {
  try {
    const { name, category, tags, status, type } = req.body;
    let { body } = req.body;

    const doc = await DietTemplate.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    if (typeof type === "string" && type !== doc.type) {
      doc.type = type;
    }

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

    // Save updater as fullName when possible
    const updatedBy = await resolveEmployeeFullName({ clientValue: "", reqUser: req.user });
    doc.version = (doc.version || 1) + 1;
    doc.updatedBy = updatedBy;

    await doc.save();
    res.json(doc);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Failed to update template" });
  }
});

// UPDATE status only
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["draft", "published", "archived"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const updatedBy = await resolveEmployeeFullName({ clientValue: "", reqUser: req.user });
    const doc = await DietTemplate.findByIdAndUpdate(
      req.params.id,
      { status, $inc: { version: 1 }, updatedBy },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update status" });
  }
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
