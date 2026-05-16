'use strict';


const express                = require('express');
const mongoose               = require('mongoose');
const crypto                 = require('crypto');
const UserHealthProfile      = require('../models/UserHealthProfile');
const SmartDietPlan          = require('../models/SmartDietPlan');
const DietOnboardingToken    = require('../models/DietOnboardingToken');
const Lead                   = require('../models/Lead');
const { computeBMR, computeTDEE, computeCalorieTarget, computeSmartCalorieTarget } = require('../services/calorieEngine');
const { generatePlan, getSwapOptions, getFoodDetails, searchFoods, SLOT_CONFIG } = require('../services/planGenerator');


const router = express.Router();


// ─── Helpers ───────────────────────────────────────────────────────────────────
function createdBy(req) {
 return req.user?.fullName || req.user?.email || 'system';
}

function round1(value) {
  return parseFloat((Number(value) || 0).toFixed(1));
}

function recalcSlotTotals(slot = {}) {
  const foods = Array.isArray(slot.foods) ? slot.foods : [];
  return {
    ...slot,
    foods,
    totalCalories: Math.round(foods.reduce((sum, food) => sum + (Number(food?.calories) || 0), 0)),
    totalSmartCalories: round1(foods.reduce((sum, food) => sum + (Number(food?.smartCalories) || 0), 0)),
    totalProtein: round1(foods.reduce((sum, food) => sum + (Number(food?.protein) || 0), 0)),
    totalCarbs: round1(foods.reduce((sum, food) => sum + (Number(food?.carbs) || 0), 0)),
    totalFat: round1(foods.reduce((sum, food) => sum + (Number(food?.fat) || 0), 0)),
    totalFiber: round1(foods.reduce((sum, food) => sum + (Number(food?.fiber) || 0), 0)),
  };
}

function recalcPlanDays(planDays = []) {
  return (Array.isArray(planDays) ? planDays : []).map(day => ({
    ...day,
    slots: (Array.isArray(day?.slots) ? day.slots : []).map(recalcSlotTotals),
  }));
}


// ─── Lead Search (for dietitian to find existing customers) ───────────────────


// GET /api/smart-diet-plan/leads-search?q=priya&limit=20
// Searches leads by name or phone for the "Generate Link" flow on the dashboard.
router.get('/leads-search', async (req, res) => {
 try {
   const { q = '', limit = 20 } = req.query;
   const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));


   if (!q.trim()) return res.json({ results: [] });


   const regex = new RegExp(q.trim().split(/\s+/).join('.*'), 'i');
   const leads = await Lead.find({
     $or: [
       { name: regex },
       { contactNumber: regex },
     ],
   })
     .select('_id name contactNumber leadStatus customerType')
     .limit(lim)
     .lean();


   res.json({
     results: leads.map(l => ({
       leadId:  String(l._id),
       name:    l.name    || '',
       phone:   l.contactNumber || '',
       status:  l.leadStatus    || '',
       type:    l.customerType  || '',
     })),
   });
 } catch (err) {
   console.error('[SmartDietPlan] leads-search error:', err);
   res.status(500).json({ error: 'Search failed' });
 }
});


// ─── Token Generation ──────────────────────────────────────────────────────────


// POST /api/smart-diet-plan/generate-token
// Dietitian calls this to get a shareable onboarding URL for a specific lead.
// Body: { leadId, clientName, clientPhone }
router.post('/generate-token', async (req, res) => {
 try {
   const { leadId, clientName, clientPhone } = req.body;
   if (!leadId) return res.status(400).json({ error: 'leadId is required' });


   // Generate a cryptographically random token
   const token = crypto.randomBytes(24).toString('hex');


   await DietOnboardingToken.create({
     token,
     leadId:      new mongoose.Types.ObjectId(leadId),
     clientName:  clientName  || '',
     clientPhone: clientPhone || '',
     createdBy:   createdBy(req),
   });


   res.json({ token, leadId, clientName, clientPhone });
 } catch (err) {
   console.error('[SmartDietPlan] generate-token error:', err);
   res.status(500).json({ error: 'Failed to generate token' });
 }
});


// GET /api/smart-diet-plan/tokens-by-lead/:leadId
// Lists all tokens generated for a lead (so the dietitian can see/revoke them).
router.get('/tokens-by-lead/:leadId', async (req, res) => {
 try {
   const tokens = await DietOnboardingToken.find({ leadId: req.params.leadId })
     .sort({ createdAt: -1 })
     .lean();
   res.json(tokens);
 } catch (err) {
   res.status(500).json({ error: 'Failed to fetch tokens' });
 }
});


// ─── Health Profile ────────────────────────────────────────────────────────────


// POST /api/smart-diet-plan/health-profile
// Create or update a client's health profile. Computes & stores calorie targets.
// leadId is optional: if omitted, we look up by phone; if no match, we generate a new ObjectId.
router.post('/health-profile', async (req, res) => {
 try {
   const {
     leadId, clientName, clientPhone,
     gender, age, heightCm, weightKg, targetWeightKg, dateOfBirth,
     activityCode, goal,
     dietType, communityCodes, healthConditions, allergies, mealsPerDay,
   } = req.body;


   if (!gender)   return res.status(400).json({ error: 'gender is required' });
   if (!age)      return res.status(400).json({ error: 'age is required' });
   if (!heightCm) return res.status(400).json({ error: 'heightCm is required' });
   if (!weightKg) return res.status(400).json({ error: 'weightKg is required' });


   // Resolve which leadId to upsert on:
   // 1. Use the provided leadId if present.
   // 2. If no leadId but phone given, find an existing profile by phone.
   // 3. Otherwise generate a fresh ObjectId so the profile is self-contained.
   let resolvedLeadId = leadId ? new mongoose.Types.ObjectId(leadId) : null;
   if (!resolvedLeadId && clientPhone) {
     const existing = await UserHealthProfile.findOne({ clientPhone: clientPhone.trim() }).lean();
     if (existing) resolvedLeadId = existing.leadId;
   }
   if (!resolvedLeadId) resolvedLeadId = new mongoose.Types.ObjectId();


   const bmr            = computeBMR({ gender, weightKg: Number(weightKg), heightCm: Number(heightCm), age: Number(age) });
   const tdee           = computeTDEE(bmr, activityCode || 'AC1');
   const calorieTarget  = computeCalorieTarget(tdee, goal || 'weightLoss');
   const smartCalTarget = computeSmartCalorieTarget(calorieTarget);


   const doc = await UserHealthProfile.findOneAndUpdate(
     { leadId: resolvedLeadId },
     {
       leadId: resolvedLeadId,
       clientName: clientName || '', clientPhone: clientPhone ? clientPhone.trim() : '',
       gender, age: Number(age), heightCm: Number(heightCm), weightKg: Number(weightKg),
       targetWeightKg: targetWeightKg ? Number(targetWeightKg) : undefined,
       dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
       activityCode: activityCode || 'AC1',
       goal:         goal || 'weightLoss',
       dietType:     dietType || 'V',
       communityCodes:   Array.isArray(communityCodes)   ? communityCodes   : ['U'],
       healthConditions: Array.isArray(healthConditions) ? healthConditions : [],
       allergies:        Array.isArray(allergies)        ? allergies        : [],
       mealsPerDay: Number(mealsPerDay) || 3,
       bmr, tdee, calorieTarget, smartCalorieTarget: smartCalTarget,
       updatedBy: createdBy(req),
     },
     { upsert: true, new: true, setDefaultsOnInsert: true }
   );


   res.json(doc);
 } catch (err) {
   console.error('[SmartDietPlan] save health-profile error:', err);
   res.status(500).json({ error: 'Failed to save health profile' });
 }
});


// GET /api/smart-diet-plan/health-profile-list?limit=100&page=1
router.get('/health-profile-list', async (req, res) => {
 try {
   const { page = 1, limit = 100, goal, dietType } = req.query;
   const pg  = Math.max(1, parseInt(page, 10) || 1);
   const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
   const filter = {};
   if (goal)     filter.goal     = goal;
   if (dietType) filter.dietType = dietType;


   const [items, total] = await Promise.all([
     UserHealthProfile.find(filter).sort({ updatedAt: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
     UserHealthProfile.countDocuments(filter),
   ]);
   res.json({ items, page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });
 } catch (err) {
   res.status(500).json({ error: 'Failed to list profiles' });
 }
});


// GET /api/smart-diet-plan/health-profile/:leadId
router.get('/health-profile/:leadId', async (req, res) => {
 try {
   const doc = await UserHealthProfile.findOne({ leadId: req.params.leadId }).lean();
   if (!doc) return res.status(404).json({ error: 'Health profile not found' });
   res.json(doc);
 } catch (err) {
   res.status(500).json({ error: 'Failed to fetch health profile' });
 }
});


// GET /api/smart-diet-plan/health-profile-by-phone/:phone
// Used by standalone onboarding to prefill an existing profile when no leadId is in the URL.
router.get('/health-profile-by-phone/:phone', async (req, res) => {
 try {
   const doc = await UserHealthProfile.findOne({ clientPhone: decodeURIComponent(req.params.phone) }).lean();
   if (!doc) return res.status(404).json({ error: 'Not found' });
   res.json(doc);
 } catch (err) {
   res.status(500).json({ error: 'Failed to fetch profile' });
 }
});


// ─── Plan Generation ───────────────────────────────────────────────────────────


// POST /api/smart-diet-plan/generate
// Generates a 7-day plan from the stored health profile for a lead.
router.post('/generate', async (req, res) => {
 try {
   const { leadId, notes } = req.body;
   if (!leadId) return res.status(400).json({ error: 'leadId is required' });


   const profile = await UserHealthProfile.findOne({ leadId }).lean();
   if (!profile) return res.status(404).json({ error: 'Health profile not found. Complete onboarding first.' });


   const result = await generatePlan(profile);


   const plan = await SmartDietPlan.create({
     leadId:     profile.leadId,
     clientName: profile.clientName,
     clientPhone: profile.clientPhone,
     healthProfileSnapshot: {
       gender:           profile.gender,
       age:              profile.age,
       heightCm:         profile.heightCm,
       weightKg:         profile.weightKg,
       targetWeightKg:   profile.targetWeightKg,
       activityCode:     profile.activityCode,
       goal:             profile.goal,
       dietType:         profile.dietType,
       communityCodes:   profile.communityCodes,
       healthConditions: profile.healthConditions,
       allergies:        profile.allergies,
       mealsPerDay:      profile.mealsPerDay,
     },
     bmr:                result.bmr,
     tdee:               result.tdee,
     calorieTarget:      result.calorieTarget,
     smartCalorieTarget: result.smartCalorieTarget,
     planDays:           result.planDays,
     validationWarnings: result.validationWarnings || [],
     sourceStats:        result.sourceStats || {},
     status:     'active',
     generatedBy: 'auto',
     createdBy:   createdBy(req),
     notes:       notes || '',
   });


   res.json(plan);
 } catch (err) {
   console.error('[SmartDietPlan] generate error:', err);
   res.status(500).json({ error: 'Failed to generate diet plan' });
 }
});


// ─── Plan CRUD ─────────────────────────────────────────────────────────────────


// GET /api/smart-diet-plan/by-lead/:leadId  — list all plans for a lead
router.get('/by-lead/:leadId', async (req, res) => {
 try {
   const { page = 1, limit = 10 } = req.query;
   const pg  = Math.max(1, parseInt(page, 10) || 1);
   const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));


   const [items, total] = await Promise.all([
     SmartDietPlan.find({ leadId: req.params.leadId })
       .select('-planDays') // omit heavy field for list view
       .sort({ createdAt: -1 })
       .skip((pg - 1) * lim)
       .limit(lim)
       .lean(),
     SmartDietPlan.countDocuments({ leadId: req.params.leadId }),
   ]);


   res.json({ items, page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });
 } catch (err) {
   res.status(500).json({ error: 'Failed to list plans' });
 }
});


// GET /api/smart-diet-plan/food-detail?source=food_recipes&foodId=123&leadId=xxx&slotIndex=4
// Returns full nutrition/recipe details plus same-slot alternatives.
router.get('/food-detail', async (req, res) => {
 try {
   const { source, foodId, leadId, slotIndex } = req.query;
   if (!source || !foodId) return res.status(400).json({ error: 'source and foodId are required' });


   const profile = leadId ? await UserHealthProfile.findOne({ leadId }).lean() : null;
   const detail = await getFoodDetails(source, foodId, profile, slotIndex);
   if (!detail) return res.status(404).json({ error: 'Food details not found' });
   res.json(detail);
 } catch (err) {
   console.error('[SmartDietPlan] food-detail error:', err);
   res.status(500).json({ error: 'Failed to fetch food details' });
 }
});


// ─── Food Search (for manual add) ─────────────────────────────────────────────
// GET /api/smart-diet-plan/food-search?q=dal&source=homeBased&slotIndex=4&leadId=xxx
router.get('/food-search', async (req, res) => {
 try {
   const { q, slotIndex, leadId } = req.query;
   if (!q || !leadId) return res.status(400).json({ error: 'q and leadId are required' });


   const profile = await UserHealthProfile.findOne({ leadId }).lean();
   if (!profile) return res.status(404).json({ error: 'Health profile not found' });


   const parsedSlotIndex =
     slotIndex !== undefined && slotIndex !== null && slotIndex !== ''
       ? parseInt(slotIndex, 10)
       : null;
   const results = await searchFoods(profile, q, Number.isNaN(parsedSlotIndex) ? null : parsedSlotIndex);
   res.json({ results });
 } catch (err) {
   res.status(500).json({ error: 'Food search failed' });
 }
});


// GET /api/smart-diet-plan/:id  — full plan with all days
router.get('/:id', async (req, res) => {
 try {
   const doc = await SmartDietPlan.findById(req.params.id).lean();
   if (!doc) return res.status(404).json({ error: 'Plan not found' });
   res.json(doc);
 } catch (err) {
   res.status(500).json({ error: 'Failed to fetch plan' });
 }
});


// PATCH /api/smart-diet-plan/:id/status
router.patch('/:id/status', async (req, res) => {
 try {
   const { status } = req.body;
   if (!['draft', 'active', 'archived'].includes(status)) {
     return res.status(400).json({ error: 'Invalid status' });
   }
   const doc = await SmartDietPlan.findByIdAndUpdate(
     req.params.id,
     { status },
     { new: true }
   ).lean();
   if (!doc) return res.status(404).json({ error: 'Plan not found' });
   res.json(doc);
 } catch (err) {
   res.status(500).json({ error: 'Failed to update status' });
 }
});


// PATCH /api/smart-diet-plan/:id/notes
router.patch('/:id/notes', async (req, res) => {
 try {
   const doc = await SmartDietPlan.findByIdAndUpdate(
     req.params.id,
     { notes: req.body.notes || '' },
     { new: true }
   ).lean();
   if (!doc) return res.status(404).json({ error: 'Plan not found' });
   res.json(doc);
 } catch (err) {
   res.status(500).json({ error: 'Failed to update notes' });
 }
});

// PUT /api/smart-diet-plan/:id/editor
// Body: { planDays?, calorieTarget?, notes? }
// Bulk editor save endpoint for the weekly diet grid.
router.put('/:id/editor', async (req, res) => {
 try {
   const { planDays, calorieTarget, notes } = req.body || {};
   const plan = await SmartDietPlan.findById(req.params.id);
   if (!plan) return res.status(404).json({ error: 'Plan not found' });

   if (planDays !== undefined) {
     plan.planDays = recalcPlanDays(planDays);
     plan.markModified('planDays');
   }

   if (calorieTarget !== undefined) {
     const nextTarget = Number(calorieTarget);
     if (!Number.isFinite(nextTarget) || nextTarget <= 0) {
       return res.status(400).json({ error: 'Invalid calorieTarget' });
     }
     plan.calorieTarget = Math.round(nextTarget);
     plan.smartCalorieTarget = computeSmartCalorieTarget(plan.calorieTarget);
   }

   if (notes !== undefined) {
     plan.notes = notes || '';
   }

   await plan.save();
   res.json(plan.toObject());
 } catch (err) {
   console.error('[SmartDietPlan] editor save error:', err);
   res.status(500).json({ error: 'Failed to save editor changes' });
 }
});


// ─── Food Swap ─────────────────────────────────────────────────────────────────


// GET /api/smart-diet-plan/swap-options/:slotIndex?leadId=xxx
// Returns top 60 eligible replacement foods for a slot based on the client's profile.
router.get('/swap-options/:slotIndex', async (req, res) => {
  try {
    const slotIndex = parseInt(req.params.slotIndex, 10);
    const { leadId, dayIndex = 0 } = req.query;
    if (!leadId) return res.status(400).json({ error: 'leadId query param required' });


   const profile = await UserHealthProfile.findOne({ leadId }).lean();
   if (!profile) return res.status(404).json({ error: 'Health profile not found' });


    const options = await getSwapOptions(slotIndex, profile, parseInt(dayIndex, 10) || 0);
    res.json({ slotIndex, options });
  } catch (err) {
   console.error('[SmartDietPlan] swap-options error:', err);
   res.status(500).json({ error: 'Failed to fetch swap options' });
 }
});


// PUT /api/smart-diet-plan/:id/swap
// Body: { dayIndex, slotIndex, foodIndexInSlot, newFood }
// Replaces one food within a slot with a new one.
router.put('/:id/swap', async (req, res) => {
 try {
   const { dayIndex, slotIndex, foodIndexInSlot, newFood } = req.body;


   if (dayIndex === undefined || slotIndex === undefined || foodIndexInSlot === undefined || !newFood) {
     return res.status(400).json({ error: 'dayIndex, slotIndex, foodIndexInSlot, and newFood are required' });
   }


   const plan = await SmartDietPlan.findById(req.params.id);
   if (!plan) return res.status(404).json({ error: 'Plan not found' });


   const day  = plan.planDays[dayIndex];
   if (!day) return res.status(400).json({ error: `Day ${dayIndex} not found` });


   const slot = day.slots.find(s => s.slotIndex === slotIndex);
   if (!slot) return res.status(400).json({ error: `Slot ${slotIndex} not found` });


   if (foodIndexInSlot < 0 || foodIndexInSlot >= slot.foods.length) {
     return res.status(400).json({ error: 'Invalid foodIndexInSlot' });
   }


   slot.foods[foodIndexInSlot] = newFood;


   // Recompute slot totals
   slot.totalCalories      = Math.round(slot.foods.reduce((s, f) => s + (f.calories || 0), 0));
   slot.totalSmartCalories = parseFloat(slot.foods.reduce((s, f) => s + (f.smartCalories || 0), 0).toFixed(2));
   slot.totalProtein       = parseFloat(slot.foods.reduce((s, f) => s + (f.protein || 0), 0).toFixed(1));
   slot.totalCarbs         = parseFloat(slot.foods.reduce((s, f) => s + (f.carbs || 0), 0).toFixed(1));
   slot.totalFat           = parseFloat(slot.foods.reduce((s, f) => s + (f.fat || 0), 0).toFixed(1));
   slot.totalFiber         = parseFloat(slot.foods.reduce((s, f) => s + (f.fiber || 0), 0).toFixed(1));


   plan.markModified('planDays');
   await plan.save();


   res.json({ ok: true, day: plan.planDays[dayIndex] });
 } catch (err) {
   console.error('[SmartDietPlan] swap error:', err);
   res.status(500).json({ error: 'Failed to swap food' });
 }
});


// PUT /api/smart-diet-plan/:id/add-food
// Body: { dayIndex, slotIndex, food }
// Adds an additional food item to a slot.
router.put('/:id/add-food', async (req, res) => {
 try {
   const { dayIndex, slotIndex, food } = req.body;
   if (dayIndex === undefined || slotIndex === undefined || !food) {
     return res.status(400).json({ error: 'dayIndex, slotIndex, and food are required' });
   }


   const plan = await SmartDietPlan.findById(req.params.id);
   if (!plan) return res.status(404).json({ error: 'Plan not found' });


   const day  = plan.planDays[dayIndex];
   if (!day) return res.status(400).json({ error: `Day ${dayIndex} not found` });


   const slot = day.slots.find(s => s.slotIndex === slotIndex);
   if (!slot) return res.status(400).json({ error: `Slot ${slotIndex} not found` });


   slot.foods.push(food);
   slot.totalCalories      = Math.round(slot.foods.reduce((s, f) => s + (f.calories || 0), 0));
   slot.totalSmartCalories = parseFloat(slot.foods.reduce((s, f) => s + (f.smartCalories || 0), 0).toFixed(2));
   slot.totalProtein       = parseFloat(slot.foods.reduce((s, f) => s + (f.protein || 0), 0).toFixed(1));
   slot.totalCarbs         = parseFloat(slot.foods.reduce((s, f) => s + (f.carbs || 0), 0).toFixed(1));
   slot.totalFat           = parseFloat(slot.foods.reduce((s, f) => s + (f.fat || 0), 0).toFixed(1));
   slot.totalFiber         = parseFloat(slot.foods.reduce((s, f) => s + (f.fiber || 0), 0).toFixed(1));


   plan.markModified('planDays');
   await plan.save();


   res.json({ ok: true, day: plan.planDays[dayIndex] });
 } catch (err) {
   res.status(500).json({ error: 'Failed to add food' });
 }
});


// DELETE /api/smart-diet-plan/:id/remove-food
// Body: { dayIndex, slotIndex, foodIndexInSlot }
router.delete('/:id/remove-food', async (req, res) => {
 try {
   const { dayIndex, slotIndex, foodIndexInSlot } = req.body;


   const plan = await SmartDietPlan.findById(req.params.id);
   if (!plan) return res.status(404).json({ error: 'Plan not found' });


   const day  = plan.planDays[dayIndex];
   const slot = day?.slots.find(s => s.slotIndex === slotIndex);
   if (!slot) return res.status(400).json({ error: 'Slot not found' });


   slot.foods.splice(foodIndexInSlot, 1);
   slot.totalCalories      = Math.round(slot.foods.reduce((s, f) => s + (f.calories || 0), 0));
   slot.totalSmartCalories = parseFloat(slot.foods.reduce((s, f) => s + (f.smartCalories || 0), 0).toFixed(2));
   slot.totalProtein       = parseFloat(slot.foods.reduce((s, f) => s + (f.protein || 0), 0).toFixed(1));
   slot.totalCarbs         = parseFloat(slot.foods.reduce((s, f) => s + (f.carbs || 0), 0).toFixed(1));
   slot.totalFat           = parseFloat(slot.foods.reduce((s, f) => s + (f.fat || 0), 0).toFixed(1));
   slot.totalFiber         = parseFloat(slot.foods.reduce((s, f) => s + (f.fiber || 0), 0).toFixed(1));


   plan.markModified('planDays');
   await plan.save();


   res.json({ ok: true, day: plan.planDays[dayIndex] });
 } catch (err) {
   res.status(500).json({ error: 'Failed to remove food' });
 }
});


// PATCH /api/smart-diet-plan/:id/log-food
// Body: { dayIndex, slotIndex, foodIndexInSlot, isConsumed? }
router.patch('/:id/log-food', async (req, res) => {
 try {
   const { dayIndex, slotIndex, foodIndexInSlot, isConsumed } = req.body;
   if (dayIndex === undefined || slotIndex === undefined || foodIndexInSlot === undefined) {
     return res.status(400).json({ error: 'dayIndex, slotIndex and foodIndexInSlot are required' });
   }


   const plan = await SmartDietPlan.findById(req.params.id);
   if (!plan) return res.status(404).json({ error: 'Plan not found' });


   const day = plan.planDays[dayIndex];
   const slot = day?.slots.find(s => s.slotIndex === slotIndex);
   if (!slot) return res.status(400).json({ error: 'Slot not found' });
   if (foodIndexInSlot < 0 || foodIndexInSlot >= slot.foods.length) {
     return res.status(400).json({ error: 'Invalid foodIndexInSlot' });
   }


   const food = slot.foods[foodIndexInSlot];
   const nextConsumed = typeof isConsumed === 'boolean' ? isConsumed : !food.isConsumed;
   food.isConsumed = nextConsumed;
   food.consumedAt = nextConsumed ? new Date() : null;


   plan.markModified('planDays');
   await plan.save();


   res.json({ ok: true, day: plan.planDays[dayIndex], foodIndexInSlot, isConsumed: nextConsumed });
 } catch (err) {
   console.error('[SmartDietPlan] log-food error:', err);
   res.status(500).json({ error: 'Failed to update food log status' });
 }
});


module.exports = router;



