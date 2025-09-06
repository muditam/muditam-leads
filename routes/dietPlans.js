// routes/dietPlans.js
const express = require("express");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const DietPlan = require("../models/DietPlan");

const router = express.Router();

const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: "failing" });
addFormats(ajv);

const weeklyBodySchema = {
  type: "object",
  required: ["fortnight"],
  properties: {
    fortnight: {
      type: "object",
      required: ["Breakfast", "Lunch", "Snacks", "Dinner"],
      additionalProperties: false,
      properties: ["Breakfast", "Lunch", "Snacks", "Dinner"].reduce((acc, m) => {
        acc[m] = { type: "array", minItems: 14, maxItems: 14, items: { type: "string" } };
        return acc;
      }, {}),
    },
  },
  additionalProperties: false,
};

const monthlyBodySchema = {
  type: "object",
  required: ["monthly"],
  properties: {
    monthly: {
      type: "object",
      required: ["Breakfast", "Lunch", "Evening Snack", "Dinner"],
      additionalProperties: false,
      properties: ["Breakfast", "Lunch", "Evening Snack", "Dinner"].reduce((acc, slot) => {
        acc[slot] = {
          type: "object",
          required: ["time", "options"],
          additionalProperties: false,
          properties: {
            time: { type: "string" },
            options: { type: "array", items: { type: "string" } },
          },
        };
        return acc;
      }, {}),
    },
  },
  additionalProperties: false,
};

const createSchema = {
  type: "object",
  required: ["customer", "plan"],
  properties: {
    customer: {
      type: "object",
      required: ["name", "leadId"],
      properties: {
        name: { type: "string", minLength: 1 },
        phone: { type: "string" },
        leadId: { type: "string" }, // allow string; Mongoose will cast
      },
      additionalProperties: false,
    },
    plan: {
      type: "object",
      required: ["planType", "templateType", "startDate", "durationDays"],
      properties: {
        planType: { type: "string", enum: ["Weekly", "Monthly"] },
        templateId: { type: "string" },
        templateLabel: { type: "string" },
        templateType: { type: "string", enum: ["weekly-14", "monthly-options"] },
        startDate: { type: "string", format: "date" },
        durationDays: { type: "integer", minimum: 1 },
        fortnight: weeklyBodySchema.properties.fortnight,
        monthly: monthlyBodySchema.properties.monthly,
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const validateCreate = ajv.compile(createSchema);

// CREATE a diet plan
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    if (!validateCreate(body)) {
      const msg = (validateCreate.errors || [])
        .map((e) => `${e.instancePath || "body"} ${e.message}`)
        .join("; ");
      return res.status(400).json({ error: msg || "Validation failed" });
    }

    const { customer, plan } = body;

    // Validate plan body type matches payload
    if (plan.planType === "Weekly" && !plan.fortnight) {
      return res.status(400).json({ error: "Weekly plan requires 'fortnight'." });
    }
    if (plan.planType === "Monthly" && !plan.monthly) {
      return res.status(400).json({ error: "Monthly plan requires 'monthly'." });
    }

    const doc = await DietPlan.create({
      customer: {
        leadId: customer.leadId,
        name: customer.name,
        phone: customer.phone || "",
      },
      planType: plan.planType,
      templateId: plan.templateId || undefined,
      templateLabel: plan.templateLabel || "",
      templateType: plan.templateType,
      startDate: new Date(plan.startDate),
      durationDays: plan.durationDays,
      fortnight: plan.planType === "Weekly" ? plan.fortnight : undefined,
      monthly: plan.planType === "Monthly" ? plan.monthly : undefined,
      createdBy: req.user?.email || "system",
      version: 1,
    });

    res.json(doc);
  } catch (e) {
    console.error("Create DietPlan error:", e);
    res.status(500).json({ error: "Failed to create diet plan" });
  }
});

// LIST diet plans by leadId OR phone (most recent first) with simple pagination
router.get("/", async (req, res) => {
  try {
    const { leadId, phone, page = 1, limit = 20 } = req.query;
    const q = {};
    if (leadId) q["customer.leadId"] = leadId;
    if (phone) q["customer.phone"] = phone;

    if (!leadId && !phone) {
      return res.status(400).json({ error: "Provide leadId or phone to list diet plans." });
    }

    const pg = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const [items, total] = await Promise.all([
      DietPlan.find(q).sort({ startDate: -1, createdAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      DietPlan.countDocuments(q),
    ]);

    res.json({ items, page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });
  } catch (e) {
    console.error("List DietPlans error:", e);
    res.status(500).json({ error: "Failed to fetch diet plans" });
  }
});

// GET one diet plan
router.get("/:id", async (req, res) => {
  try {
    const doc = await DietPlan.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch diet plan" });
  }
});

module.exports = router;
