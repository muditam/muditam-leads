const express = require("express");
const router = express.Router();


const Lead = require("../models/Lead");
const DietPlan = require("../models/DietPlan");
const Employee = require("../models/Employee");


const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();


function cacheGet(key) {
 const entry = _cache.get(key);
 if (!entry) return null;


 if (Date.now() - entry.ts > CACHE_TTL_MS) {
   _cache.delete(key);
   return null;
 }


 return entry.data;
}


function cacheSet(key, data) {
 _cache.set(key, { ts: Date.now(), data });
}


function normalizeAgentName(name) {
 if (!name) return "";
 return String(name).replace(/\s*\([^)]*@[^)]*\)\s*$/i, "").trim();
}


function agentKey(name) {
 return normalizeAgentName(name).toLowerCase();
}


function hasNumber(value) {
 return value !== null && value !== undefined && value !== "" && !Number.isNaN(value);
}


function hasText(value) {
 return typeof value === "string" && value.trim() !== "";
}


function hasDiabetes(details = {}) {
 return (
   hasNumber(details.hba1c) ||
   hasNumber(details.fastingSugar) ||
   hasNumber(details.ppSugar) ||
   hasText(details.durationOfDiabetes) ||
   hasText(details.lastTestDone)
 );
}


function hasLiver(details = {}) {
 return (
   hasNumber(details.sgpt) ||
   hasNumber(details.sgot) ||
   hasNumber(details.ggt) ||
   hasText(details.ultrasoundFindings) ||
   hasText(details.lastLiverTest)
 );
}


function hasCholesterol(details = {}) {
 return (
   hasNumber(details.totalCholesterol) ||
   hasNumber(details.ldl) ||
   hasNumber(details.hdl) ||
   hasNumber(details.triglycerides) ||
   hasText(details.lastCholesterolTest)
 );
}


const ACTIVE_CUSTOMER_MATCH = {
 salesStatus: "Sales Done",
 $or: [
   { retentionStatus: { $regex: /^active$/i } },
   { retentionStatus: { $exists: false } },
   { retentionStatus: null },
   { retentionStatus: "" },
 ],
};


const ACTIVE_LOOKUP_LEAD_MATCH = {
 "lead.salesStatus": "Sales Done",
 $or: [
   { "lead.retentionStatus": { $regex: /^active$/i } },
   { "lead.retentionStatus": { $exists: false } },
   { "lead.retentionStatus": null },
   { "lead.retentionStatus": "" },
 ],
};


const PROFILE_FILLED_OR = [
 { "details.age": { $type: "number" } },
 { "details.height": { $type: "number" } },
 { "details.weight": { $type: "number" } },
 { "details.gender": { $exists: true, $ne: "" } },
 { "details.dietType": { $exists: true, $ne: "" } },
];


const CONDITION_FILLED_OR = [
 { "details.hba1c": { $type: "number" } },
 { "details.fastingSugar": { $type: "number" } },
 { "details.ppSugar": { $type: "number" } },
 { "details.durationOfDiabetes": { $exists: true, $ne: "" } },
 { "details.lastTestDone": { $exists: true, $ne: "" } },


 { "details.totalCholesterol": { $type: "number" } },
 { "details.ldl": { $type: "number" } },
 { "details.hdl": { $type: "number" } },
 { "details.triglycerides": { $type: "number" } },
 { "details.lastCholesterolTest": { $exists: true, $ne: "" } },


 { "details.sgpt": { $type: "number" } },
 { "details.sgot": { $type: "number" } },
 { "details.ggt": { $type: "number" } },
 { "details.ultrasoundFindings": { $exists: true, $ne: "" } },
 { "details.lastLiverTest": { $exists: true, $ne: "" } },
];


router.get("/condition-cards", async (req, res) => {
 const rawAgentNames = String(req.query?.agentNames || "").trim();
 const agentNames = rawAgentNames
   ? rawAgentNames
       .split(",")
       .map((n) => n.trim())
       .filter(Boolean)
   : [];


 const cacheKey = agentNames.length
   ? `condition-cards:${agentNames.slice().sort().join("|")}`
   : "condition-cards";
 const cached = cacheGet(cacheKey);
 if (cached) {
   return res.json(cached);
 }


 try {
   const matchQuery = { ...ACTIVE_CUSTOMER_MATCH };
   if (agentNames.length) {
     matchQuery.healthExpertAssigned = { $in: agentNames };
   }


   const allLeads = await Lead.find(matchQuery)
     .select("details")
     .lean();


   let diabetes = 0;
   let liver = 0;
   let cholesterol = 0;
   let noCondition = 0;


   allLeads.forEach((lead) => {
     const details = lead.details || {};


     const isDiabetes = hasDiabetes(details);
     const isLiver = hasLiver(details);
     const isCholesterol = hasCholesterol(details);


     if (isDiabetes) diabetes++;
     if (isLiver) liver++;
     if (isCholesterol) cholesterol++;


     if (!isDiabetes && !isLiver && !isCholesterol) {
       noCondition++;
     }
   });


   const result = {
     diabetes,
     liver,
     cholesterol,
     noCondition,
   };


   cacheSet(cacheKey, result);
   return res.json(result);
 } catch (err) {
   console.error("condition-cards ERROR:", err.message);
   return res.status(500).json({
     error: "Internal server error",
     details: err.message,
   });
 }
});


router.get("/health-expert-activity-summary", async (req, res) => {
 try {
   const { startDate, endDate } = req.query;


   if (!startDate || !endDate) {
     return res.status(400).json({
       error: "startDate and endDate are required",
     });
   }


   const cacheKey = `activity-summary:${startDate}:${endDate}`;
   const cached = cacheGet(cacheKey);
   if (cached) {
     return res.json(cached);
   }


   const start = new Date(`${startDate}T00:00:00+05:30`);
   const end = new Date(`${endDate}T23:59:59+05:30`);


   const activeEmployees = await Employee.find({
     status: { $regex: /^active$/i },
     role: { $regex: /retention agent/i },
   })
     .select("fullName role status")
     .lean();


   const activeAgentMap = new Map();
   activeEmployees.forEach((emp) => {
     const display = normalizeAgentName(emp.fullName);
     const key = agentKey(emp.fullName);
     if (display && key) {
       activeAgentMap.set(key, display);
     }
   });


   if (activeAgentMap.size === 0) {
     return res.json({
       range: { startDate, endDate },
       rows: [],
       totals: {
         assignedTotal: 0,
         dietPlansCreated: 0,
         profileUpdates: 0,
         profileUpdatesPct: 0,
         conditionUpdates: 0,
         conditionUpdatesPct: 0,
         firstCallConnected: 0,
         firstCallPercentage: 0,
       },
     });
   }


   const leadCollectionName = Lead.collection.name;


   const [
     dietPlansAgg,
     assignedLeadsAgg,
     profileUpdatesAgg,
     conditionUpdatesAgg,
     firstCallAgg,
   ] = await Promise.all([
     DietPlan.aggregate([
       {
         $match: {
           createdAt: { $gte: start, $lte: end },
           "customer.leadId": { $exists: true, $ne: null },
         },
       },
       {
         $lookup: {
           from: leadCollectionName,
           localField: "customer.leadId",
           foreignField: "_id",
           as: "lead",
         },
       },
       { $unwind: { path: "$lead", preserveNullAndEmptyArrays: false } },
       {
         $match: {
           ...ACTIVE_LOOKUP_LEAD_MATCH,
           "lead.healthExpertAssigned": { $exists: true, $ne: null, $ne: "" },
         },
       },
       {
         $group: {
           _id: {
             agent: "$lead.healthExpertAssigned",
             leadId: "$lead._id",
           },
         },
       },
       {
         $group: {
           _id: "$_id.agent",
           count: { $sum: 1 },
         },
       },
     ]),


     Lead.aggregate([
       {
         $match: {
           ...ACTIVE_CUSTOMER_MATCH,
           healthExpertAssigned: { $exists: true, $ne: null, $ne: "" },
         },
       },
       {
         $group: {
           _id: "$healthExpertAssigned",
           count: { $sum: 1 },
         },
       },
     ]),


     Lead.aggregate([
       {
         $match: {
           ...ACTIVE_CUSTOMER_MATCH,
           healthExpertAssigned: { $exists: true, $ne: null, $ne: "" },
           details: { $exists: true, $ne: null },
           $or: PROFILE_FILLED_OR,
         },
       },
       {
         $group: {
           _id: "$healthExpertAssigned",
           count: { $sum: 1 },
         },
       },
     ]),


     Lead.aggregate([
       {
         $match: {
           ...ACTIVE_CUSTOMER_MATCH,
           healthExpertAssigned: { $exists: true, $ne: null, $ne: "" },
           details: { $exists: true, $ne: null },
           $or: CONDITION_FILLED_OR,
         },
       },
       {
         $group: {
           _id: "$healthExpertAssigned",
           count: { $sum: 1 },
         },
       },
     ]),


     Lead.aggregate([
       {
         $match: {
           ...ACTIVE_CUSTOMER_MATCH,
           healthExpertAssigned: { $exists: true, $ne: null, $ne: "" },
           firstCallConnected: true,
           firstCallConnectedAt: { $gte: start, $lte: end },
         },
       },
       {
         $group: {
           _id: "$healthExpertAssigned",
           connected: { $sum: 1 },
         },
       },
     ]),
   ]);


   const dietPlansByKey = {};
   const assignedByKey = {};
   const profileByKey = {};
   const conditionByKey = {};
   const firstCallByKey = {};


   dietPlansAgg.forEach((item) => {
     const k = agentKey(item._id);
     if (k && activeAgentMap.has(k)) {
       dietPlansByKey[k] = item.count || 0;
     }
   });


   assignedLeadsAgg.forEach((item) => {
     const k = agentKey(item._id);
     if (k && activeAgentMap.has(k)) {
       assignedByKey[k] = item.count || 0;
     }
   });


   profileUpdatesAgg.forEach((item) => {
     const k = agentKey(item._id);
     if (k && activeAgentMap.has(k)) {
       profileByKey[k] = item.count || 0;
     }
   });


   conditionUpdatesAgg.forEach((item) => {
     const k = agentKey(item._id);
     if (k && activeAgentMap.has(k)) {
       conditionByKey[k] = item.count || 0;
     }
   });


   firstCallAgg.forEach((item) => {
     const k = agentKey(item._id);
     if (k && activeAgentMap.has(k)) {
       firstCallByKey[k] = item.connected || 0;
     }
   });


   const rows = [];
   let totAssigned = 0;
   let totDiet = 0;
   let totProfile = 0;
   let totCondition = 0;
   let totConnected = 0;


   const agentKeysSorted = Array.from(activeAgentMap.keys()).sort((a, b) =>
     activeAgentMap.get(a).localeCompare(activeAgentMap.get(b))
   );


   agentKeysSorted.forEach((k) => {
     const agentName = activeAgentMap.get(k);
     const assignedTotal = assignedByKey[k] || 0;
     const dietPlansCreated = dietPlansByKey[k] || 0;


     const profileUpdates = Math.min(profileByKey[k] || 0, assignedTotal);
     const conditionUpdates = Math.min(conditionByKey[k] || 0, assignedTotal);


     const profileUpdatesPct =
       assignedTotal > 0
         ? +((profileUpdates / assignedTotal) * 100).toFixed(1)
         : 0;


     const conditionUpdatesPct =
       assignedTotal > 0
         ? +((conditionUpdates / assignedTotal) * 100).toFixed(1)
         : 0;


     const firstCallConnected = firstCallByKey[k] || 0;


     const firstCallPercentage =
       assignedTotal > 0
         ? +((firstCallConnected / assignedTotal) * 100).toFixed(2)
         : 0;


     totAssigned += assignedTotal;
     totDiet += dietPlansCreated;
     totProfile += profileUpdates;
     totCondition += conditionUpdates;
     totConnected += firstCallConnected;


     rows.push({
       agentName,
       assignedTotal,
       dietPlansCreated,
       profileUpdates,
       profileUpdatesPct,
       conditionUpdates,
       conditionUpdatesPct,
       firstCallConnected,
       firstCallPercentage,
     });
   });


   const totProfilePct =
     totAssigned > 0 ? +((totProfile / totAssigned) * 100).toFixed(1) : 0;


   const totConditionPct =
     totAssigned > 0 ? +((totCondition / totAssigned) * 100).toFixed(1) : 0;


   const totFirstCallPct =
     totAssigned > 0 ? +((totConnected / totAssigned) * 100).toFixed(2) : 0;


   const response = {
     range: { startDate, endDate },
     rows,
     totals: {
       assignedTotal: totAssigned,
       dietPlansCreated: totDiet,
       profileUpdates: totProfile,
       profileUpdatesPct: totProfilePct,
       conditionUpdates: totCondition,
       conditionUpdatesPct: totConditionPct,
       firstCallConnected: totConnected,
       firstCallPercentage: totFirstCallPct,
     },
   };


   cacheSet(cacheKey, response);
   return res.json(response);
 } catch (err) {
   console.error("activity-summary ERROR:", err.message);
   console.error(err.stack);
   return res.status(500).json({
     error: "Internal server error",
     details: err.message,
   });
 }
});


router.delete("/cache", (req, res) => {
 _cache.clear();
 console.log("Server cache cleared");
 return res.json({
   cleared: true,
   message: "Server cache cleared",
 });
});


module.exports = router;



