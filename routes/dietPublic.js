'use strict';


// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC routes — NO auth/session required.
// These are called by the client-facing onboarding page which is shared as a
// link and opened by people who are NOT logged into the CRM.
// ─────────────────────────────────────────────────────────────────────────────


const express              = require('express');
const mongoose             = require('mongoose');
const DietOnboardingToken  = require('../models/DietOnboardingToken');
const UserHealthProfile    = require('../models/UserHealthProfile');
const { computeBMR, computeTDEE, computeCalorieTarget, computeSmartCalorieTarget } = require('../services/calorieEngine');


const router = express.Router();


// ── GET /api/diet-public/token/:token ─────────────────────────────────────────
// Validates a token and returns the prefill data (name, phone).
// Called by the onboarding page as soon as it loads.
router.get('/token/:token', async (req, res) => {
 try {
   const doc = await DietOnboardingToken.findOne({ token: req.params.token }).lean();


   if (!doc) {
     return res.status(404).json({ error: 'This link is invalid or has expired.' });
   }


   if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) {
     return res.status(410).json({ error: 'This link has expired. Please ask for a new one.' });
   }


   // Return minimal info needed to prefill the form
   res.json({
     valid:       true,
     leadId:      doc.leadId,
     clientName:  doc.clientName,
     clientPhone: doc.clientPhone,
     used:        doc.used,
   });
 } catch (err) {
   res.status(500).json({ error: 'Could not validate link.' });
 }
});


// ── POST /api/diet-public/health-profile ──────────────────────────────────────
// Saves a client's health profile submitted via the shareable onboarding link.
// Accepts `token` in the body; resolves leadId from it.
router.post('/health-profile', async (req, res) => {
 try {
   const {
     token,
     clientName, clientPhone,
     gender, age, heightCm, weightKg, targetWeightKg, dateOfBirth,
     activityCode, goal,
     dietType, communityCodes, healthConditions, allergies, mealsPerDay,
   } = req.body;


   if (!gender)   return res.status(400).json({ error: 'Gender is required.' });
   if (!age)      return res.status(400).json({ error: 'Age is required.' });
   if (!heightCm) return res.status(400).json({ error: 'Height is required.' });
   if (!weightKg) return res.status(400).json({ error: 'Weight is required.' });


   // ── Resolve leadId ────────────────────────────────────────────────────────
   let resolvedLeadId = null;


   if (token) {
     const tokenDoc = await DietOnboardingToken.findOne({ token }).lean();
     if (!tokenDoc) return res.status(404).json({ error: 'Invalid or expired link.' });
     if (tokenDoc.expiresAt && new Date() > new Date(tokenDoc.expiresAt)) {
       return res.status(410).json({ error: 'This link has expired.' });
     }
     resolvedLeadId = tokenDoc.leadId;
   }


   // Fallback: look up by phone if no token was provided
   if (!resolvedLeadId && clientPhone) {
     const existing = await UserHealthProfile.findOne({ clientPhone: clientPhone.trim() }).lean();
     if (existing) resolvedLeadId = existing.leadId;
   }


   if (!resolvedLeadId) resolvedLeadId = new mongoose.Types.ObjectId();


   // ── Compute targets ───────────────────────────────────────────────────────
   const bmr            = computeBMR({ gender, weightKg: Number(weightKg), heightCm: Number(heightCm), age: Number(age) });
   const tdee           = computeTDEE(bmr, activityCode || 'AC1');
   const calorieTarget  = computeCalorieTarget(tdee, goal || 'weightLoss');
   const smartCalTarget = computeSmartCalorieTarget(calorieTarget);


   // ── Upsert profile ────────────────────────────────────────────────────────
   const profile = await UserHealthProfile.findOneAndUpdate(
     { leadId: resolvedLeadId },
     {
       leadId:      resolvedLeadId,
       clientName:  clientName  || '',
       clientPhone: clientPhone ? clientPhone.trim() : '',
       gender,
       age:             Number(age),
       heightCm:        Number(heightCm),
       weightKg:        Number(weightKg),
       targetWeightKg:  targetWeightKg ? Number(targetWeightKg) : undefined,
       dateOfBirth:     dateOfBirth    ? new Date(dateOfBirth)  : undefined,
       activityCode:    activityCode   || 'AC1',
       goal:            goal           || 'weightLoss',
       dietType:        dietType       || 'V',
       communityCodes:   Array.isArray(communityCodes)   ? communityCodes   : ['U'],
       healthConditions: Array.isArray(healthConditions) ? healthConditions : [],
       allergies:        Array.isArray(allergies)        ? allergies        : [],
       mealsPerDay:     Number(mealsPerDay) || 3,
       bmr, tdee, calorieTarget,
       smartCalorieTarget: smartCalTarget,
       updatedBy: 'client-self',
     },
     { upsert: true, new: true, setDefaultsOnInsert: true }
   );


   // Mark token as used (non-blocking)
   if (token) {
     DietOnboardingToken.findOneAndUpdate(
       { token },
       { used: true, usedAt: new Date() },
       {}
     ).catch(() => {});
   }


   res.json({ ok: true, leadId: String(resolvedLeadId), profile });
 } catch (err) {
   console.error('[dietPublic] health-profile error:', err);
   res.status(500).json({ error: 'Failed to save your profile. Please try again.' });
 }
});


module.exports = router;



