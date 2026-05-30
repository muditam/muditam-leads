'use strict';


const FoodByCat  = require('../models/FoodByCat');
const FoodRecipe = require('../models/FoodRecipe');
const HomeBased  = require('../models/HomeBased');
const Packaged   = require('../models/Packaged');
const Restaurant = require('../models/Restaurant');
const { computeBMR, computeTDEE, computeCalorieTarget, computeSmartCalorieTarget, deriveSmartCalories } = require('./calorieEngine');


const PRIMARY_SOURCES = new Set(['food_recipes']);
const SECONDARY_SOURCES = new Set(['homeBased']);
const TERTIARY_SOURCES = new Set(['food_by_cat']);
const COMMERCIAL_SOURCES = new Set(['Packaged', 'restaurants']);
const SOURCE_PRIORITY = {
 food_recipes: 50,
 homeBased: 45,
 food_by_cat: 20,
 Packaged: 5,
 restaurants: 5,
};
const CORE_SLOT_INDICES = new Set([2, 4, 7]);
const CONDIMENT_RE = /\b(sauce|pickle|dip|dressing|mustard|chutney|salsa|kasundi|tapenade|pesto|spread|seasoning)\b/i;


// ─── Slot configuration ────────────────────────────────────────────────────────
// typeCodes: food Type codes eligible for this slot
// scWeight:  proportion of total SmartCalorie budget assigned to this slot
const SLOT_CONFIG = [
 { index: 0, name: 'Early Morning',  time: '6:30 AM',  typeCodes: ['DZ'],                                          maxItems: 1,  scWeight: 0.04 },
 { index: 1, name: 'Pre-Breakfast',  time: '8:00 AM',  typeCodes: ['F', 'N'],                                      maxItems: 2,  scWeight: 0.06 },
 { index: 2, name: 'Breakfast',      time: '9:00 AM',  typeCodes: ['M', 'B', 'P'],                                 maxItems: 3,  scWeight: 0.20 },
 { index: 3, name: 'Mid Morning',    time: '11:00 AM', typeCodes: ['F', 'N', 'Y'],                                 maxItems: 2,  scWeight: 0.06 },
 { index: 4, name: 'Lunch',          time: '1:00 PM',  typeCodes: ['W', 'C', 'B', 'R', 'S', 'SO', 'SD', 'P', 'FI'], maxItems: 4, scWeight: 0.25 },
 { index: 5, name: 'Post Lunch',     time: '3:30 PM',  typeCodes: ['D', 'F'],                                      maxItems: 1,  scWeight: 0.04 },
 { index: 6, name: 'Evening Snack',  time: '5:00 PM',  typeCodes: ['NS', 'F', 'Y', 'PW'],                         maxItems: 2,  scWeight: 0.10 },
 { index: 7, name: 'Dinner',         time: '7:30 PM',  typeCodes: ['W', 'C', 'B', 'R', 'S', 'SO', 'SD', 'P'],    maxItems: 4,  scWeight: 0.22 },
 { index: 8, name: 'Post Dinner',    time: '9:30 PM',  typeCodes: ['DZ', 'D'],                                     maxItems: 1,  scWeight: 0.03 },
];


// Active slot indices by meals-per-day preference
function getActiveSlotIndices(mealsPerDay) {
 const n = Math.max(2, Math.min(8, mealsPerDay || 3));
 if (n <= 2) return [2, 7];
 if (n === 3) return [2, 4, 7];
 if (n === 4) return [2, 4, 6, 7];
 if (n === 5) return [0, 2, 4, 6, 7];
 if (n === 6) return [0, 2, 3, 4, 6, 7];
 if (n === 7) return [0, 1, 2, 4, 6, 7, 8];
 return [0, 1, 2, 3, 4, 5, 6, 7, 8];
}


// ─── Field normalization ───────────────────────────────────────────────────────
// Each food collection has slight naming inconsistencies; normalize to a single shape.
function normalizeFood(raw, source) {
 const name = String(raw.Food || raw.Name || raw.foodItem || '').trim();
 if (!name) return null;


 const calories     = parseFloat(raw.Calories    || raw.unitCalories || 0)  || 0;
 const score        = parseFloat(raw.Score       || 0)                       || 0;
 let   smartCal     = parseFloat(raw.SmartCalories || raw.smartCalories || 0) || 0;
 if (smartCal === 0 && calories > 0) smartCal = deriveSmartCalories(calories, score);


 const protein      = parseFloat(raw.Protien || raw.Protein || raw.unitProtein || 0) || 0;
 const carbs        = parseFloat(raw.Carbs   || raw.unitCarbs || 0)  || 0;
 const fat          = parseFloat(raw.Fat     || raw.unitFat   || 0)  || 0;
 const fiber        = parseFloat(raw.Fiber   || raw.unitFiber || 0)  || 0;
 const foodType     = String(raw.foodType || '').trim();
 const cleanText = (v) => {
   if (v === undefined || v === null) return '';
   const text = Array.isArray(v) ? v.join('\n') : String(v);
   const trimmed = text.trim();
   return trimmed === '-' || trimmed === '--' || trimmed === '~' ? '' : trimmed;
 };
 const toList = (v) => {
   if (v === undefined || v === null) return [];
   const items = Array.isArray(v) ? v : [v];
   return items
     .flatMap(item => String(item).replace(/[\[\]]/g, '').split(','))
     .map(s => s.trim().replace(/^['"]+|['"]+$/g, ''))
     .filter(Boolean)
     .filter(s => s !== '-');
 };
 const recipe       = cleanText(raw.recipe);
 const steps        = cleanText(raw.steps);
 const video        = cleanText(raw.video).replace(/^"|"$/g, '');
 const sourceUrl    = cleanText(raw.source);
 const remark       = cleanText(raw.remark || raw.Remark || raw.message);


 // Type → array (may be "W,C" or ["W","C"])
 const typeRaw = raw.Type || raw.type || '';
 const typeArr = Array.isArray(typeRaw)
   ? typeRaw.map(String)
   : String(typeRaw).split(/[,\s]+/).map(t => t.trim()).filter(Boolean);


 // Community → array (may be "U,P" or ["U","P"])
 const commRaw = raw.Community || raw.community || '';
 let communityArr = toList(commRaw);
 // Packaged/Restaurant items carry no community tag → treat as Universal
 if (communityArr.length === 0 && (source === 'Packaged' || source === 'restaurants')) {
   communityArr = ['U'];
 }


 // avoidIn / recommendedIn → arrays (food_recipes has these; others may not)
 const toArr = (v) => toList(v);


 return {
   _id:           String(raw._id || raw.code || ''),
   source,
   name,
   calories,
   smartCalories: smartCal,
   score,
   protein,
   carbs,
   fat,
   fiber,
   foodType,
   typeArr,
   communityArr,
   avoidIn:        toArr(raw.avoidIn),
   recommendedIn:  toArr(raw.recommendedIn),
   imageId:        String(raw.imageId    || ''),
   nutriScore:     String(raw.nutriScore || raw.nutriScoreSDP || ''),
   brandName:      String(raw.brandName  || raw.brand         || ''),
   portion:        raw.portion    || '',
   portionUnit:    String(raw.portion_unit || raw.portionUnit || raw.measuring_unit || ''),
   recipe,
   steps,
   video,
   remark,
   sourceUrl,
   hasRecipe:      recipe.length > 0,
   hasSteps:       steps.length > 0,
   hasVideo:       /^https?:\/\//i.test(video),
   hasImage:       /^https?:\/\//i.test(String(raw.imageId || '')),
   isPrimarySource: PRIMARY_SOURCES.has(source),
   isFallbackSource: !PRIMARY_SOURCES.has(source),
   isCommercialSource: COMMERCIAL_SOURCES.has(source),
   isCondiment:    CONDIMENT_RE.test(name) || /table\s*spoon|tablespoon|tbsp/i.test(String(raw.portion_unit || raw.portionUnit || raw.measuring_unit || '')),
 };
}


function hasCriticalFields(food) {
 return Boolean(
   food &&
   food.name &&
   food.calories > 0 &&
   food.smartCalories > 0 &&
   food.typeArr.length > 0 &&
   food.foodType &&
   food.portion !== '' &&
   food.portion !== undefined &&
   food.portion !== null
 );
}


function isCoreMealFriendlyFood(food) {
 if (!food) return false;
 const name = String(food.name || '').toLowerCase();
 const portionUnit = String(food.portionUnit || '').toLowerCase();
 const brandedFoodByCat = food.source === 'food_by_cat' && String(food.brandName || '').trim();
 const tinyPortion = /(tablespoon|tbsp|teaspoon|tsp|slice|piece)/i.test(portionUnit) && Number(food.calories || 0) < 120;
 const processedKeywords = /\b(syrup|dressing|paste|spread|sauce|dip|pickle|seasoning)\b/i.test(name);
 return !food.isCondiment && !food.isCommercialSource && !brandedFoodByCat && !tinyPortion && !processedKeywords;
}


function isLunchDinnerMealFood(food) {
 if (!food) return false;
 const typeArr = Array.isArray(food.typeArr) ? food.typeArr : [];
 const name = String(food.name || '').toLowerCase();
 if (/\b(omelette|omelet|pancake|porridge|smoothie|shake|boats|sushi|toast|dalia|oats|oatmeal|overnight|granola|muesli|crisp|ladoo|laddu|burfi|barfi|halwa|kheer|cake|chocolate|dessert|sweet)\b/i.test(name)) return false;
 const hasMainMealType = typeArr.some(t => ['W', 'C', 'B', 'R', 'S', 'SO', 'SD', 'FI'].includes(t));
 if (hasMainMealType) return true;
  if (typeArr.length === 1 && typeArr[0] === 'P') {
   return /\b(dal|curry|paneer|tofu|salad|soup|khichdi|rice|roti|paratha|sabzi|vegetable|tikki|chilla|cheela|dosa|idli|upma)\b/i.test(name);
  }
  return false;
}


function isSlotAppropriateFood(slot, food) {
 if (!slot || !food) return false;
 const name = String(food.name || '').toLowerCase();
 const portionUnit = String(food.portionUnit || '').toLowerCase();
 const isSoupOrSalad = /\b(soup|salad)\b/i.test(name);
 const isSweet = /\b(ladoo|laddu|burfi|barfi|halwa|kheer|cake|chocolate|dessert|sweet|syrup)\b/i.test(name);
 const isBreakfastStyle = /\b(omelette|omelet|pancake|porridge|smoothie|shake|toast|idli|dosa|upma|poha|chilla|cheela)\b/i.test(name);
 const isMainMealStyle = /\b(dal|curry|paneer|tofu|khichdi|rice|roti|paratha|sabzi|vegetable|pulao|chapati)\b/i.test(name);
 const isBreakfastExcluded = /\b(rice|pulao|curry|dal|salad|soup)\b/i.test(name);
 const isSnackStyle = /\b(fruit|nuts?|makhana|yogurt|curd|lassi|chaat|snack|cutlet|tikki|sundal|bhel)\b/i.test(name);
 const isSnackExcluded = /\b(rice|roti|paratha|chapati|curry|dal|sabzi|khichdi|pulao)\b/i.test(name);
 const tinyPortion = /(tablespoon|tbsp|teaspoon|tsp|slice|piece)/i.test(portionUnit) && Number(food.calories || 0) < 120;

 if (food.isCondiment || tinyPortion) return false;

 if (slot.index === 2) {
   return !isSoupOrSalad && !isSweet && !isBreakfastExcluded;
 }
 if (slot.index === 4 || slot.index === 7) {
   return isLunchDinnerMealFood(food) && !isSweet && !isBreakfastStyle && !isSoupOrSalad;
 }
 if (slot.index === 6) {
   return !isMainMealStyle && !food.isCondiment && !isSweet && (isSnackStyle || !isSnackExcluded);
 }
 if (slot.index === 0 || slot.index === 1 || slot.index === 3 || slot.index === 5 || slot.index === 8) {
   return !isMainMealStyle || isSoupOrSalad || isBreakfastStyle;
 }
 return true;
}


// ─── Step 3 – dietType filter (at DB level) ───────────────────────────────────
function buildDietTypeFilter(dietType) {
 const V_SET  = ['V', 'v'];
 const VE_SET = ['Ve', 've', 'VE'];
 const E_SET  = ['E', 'e'];
 if (dietType === 'V')  return { foodType: { $in: [...V_SET, ...VE_SET] } };
 if (dietType === 'Ve') return { foodType: { $in: VE_SET } };
 if (dietType === 'E')  return { foodType: { $in: [...V_SET, ...VE_SET, ...E_SET] } };
 return {}; // NV: all types
}


// ─── Step 4 – community filter (in-memory) ────────────────────────────────────
function passesCommunityFilter(food, communityCodes) {
 if (!communityCodes || communityCodes.length === 0) return true;
 if (food.communityArr.length === 0) return true; // no tag → include
 const allowed = new Set(['U', ...communityCodes]);
 return food.communityArr.some(c => allowed.has(c));
}


// ─── Step 5 – health conditions filter (in-memory) ────────────────────────────
function passesConditionsFilter(food, healthConditions) {
 if (!healthConditions || healthConditions.length === 0) return true;
 if (food.avoidIn.length === 0) return true;
 const avoid = new Set(food.avoidIn.map(s => s.toLowerCase()));
 return !healthConditions.some(c => avoid.has(c.toLowerCase()));
}


// ─── Step 6 – allergy filter (in-memory) ──────────────────────────────────────
// Allergy codes → keywords to match against food name / avoidIn
const ALLERGY_KW = {
 SF:  ['seafood', 'fish', 'prawn', 'shrimp', 'crab', 'lobster', 'tuna', 'salmon'],
 SO:  ['seafood', 'fish', 'prawn', 'shrimp'],
 ML:  ['milk', 'dairy', 'curd', 'yogurt', 'cheese', 'paneer', 'butter', 'ghee', 'cream', 'lactose', 'lassi', 'whey'],
 G:   ['gluten', 'wheat', 'maida', 'barley', 'rye', 'semolina', 'rava', 'suji', 'pasta', 'noodle', 'bread', 'roti', 'paratha', 'biscuit'],
};


function passesAllergyFilter(food, allergies) {
 if (!allergies || allergies.length === 0) return true;
 const nameLower  = food.name.toLowerCase();
 const avoidLower = food.avoidIn.map(s => s.toLowerCase());


 for (const code of allergies) {
   // Fruit allergy: exclude foods with Type code 'F'
   if (code === 'F'  && food.typeArr.includes('F')) return false;
   // Egg allergy: exclude Eggetarian foods
   if (code === 'E'  && (food.foodType === 'E' || food.foodType === 'e')) return false;
   // Nut allergy: exclude nut/nut-snack type foods
   if (code === 'N'  && food.typeArr.some(t => t === 'N' || t === 'NS')) return false;


   const kws = ALLERGY_KW[code] || [];
   if (kws.length && kws.some(kw => nameLower.includes(kw) || avoidLower.some(a => a.includes(kw)))) {
     return false;
   }
 }
 return true;
}


function sourceRank(food) {
 return SOURCE_PRIORITY[food.source] || 0;
}

function communityPriority(food, communityCodes = []) {
 if (!Array.isArray(communityCodes) || communityCodes.length === 0) return 0;
 const foodCommunities = Array.isArray(food?.communityArr) ? food.communityArr.map(code => String(code || '').trim().toUpperCase()) : [];
 if (!foodCommunities.length) return 1;

 const selected = new Set(communityCodes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean));
 const hasExact = foodCommunities.some(code => selected.has(code));
 if (hasExact) return 3;
 if (foodCommunities.includes('U')) return 2;
 return 0;
}


function completenessScore(food) {
 return Number(food.hasRecipe) * 4 + Number(food.hasSteps) * 4 + Number(food.hasVideo) * 2 + Number(food.hasImage);
}


function dedupeFoods(foods) {
 const byKey = new Map();
 for (const food of foods) {
   const key = [
     food.name.toLowerCase().replace(/\s+/g, ' ').trim(),
     food.typeArr.slice().sort().join('|'),
     String(food.portion || '').toLowerCase(),
     String(food.portionUnit || '').toLowerCase(),
   ].join('::');
   const prev = byKey.get(key);
   if (!prev) {
     byKey.set(key, food);
     continue;
   }
   const currentWeight =
     sourceRank(food) + completenessScore(food) + Number(food.source === 'food_recipes' && (food.hasRecipe || food.hasSteps)) * 10;
   const prevWeight =
     sourceRank(prev) + completenessScore(prev) + Number(prev.source === 'food_recipes' && (prev.hasRecipe || prev.hasSteps)) * 10;
   if (currentWeight > prevWeight) byKey.set(key, food);
 }
 return [...byKey.values()];
}


// ─── Sorting: recommended foods first, then Score/source/completeness ─────────
function sortByPriorityAndScore(foods, healthConditions, scBudget, communityCodes = []) {
 const condSet = new Set((healthConditions || []).map(c => c.toLowerCase()));
 return foods.slice().sort((a, b) => {
   const aRec = a.recommendedIn.some(r => condSet.has(r.toLowerCase())) ? 1 : 0;
   const bRec = b.recommendedIn.some(r => condSet.has(r.toLowerCase())) ? 1 : 0;
   if (bRec !== aRec) return bRec - aRec;
   const aCommunity = communityPriority(a, communityCodes);
   const bCommunity = communityPriority(b, communityCodes);
   if (bCommunity !== aCommunity) return bCommunity - aCommunity;
   if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
   if ((a.smartCalories || 0) !== (b.smartCalories || 0)) {
     return (a.smartCalories || 0) - (b.smartCalories || 0);
   }
   if (sourceRank(b) !== sourceRank(a)) return sourceRank(b) - sourceRank(a);
   if (completenessScore(b) !== completenessScore(a)) return completenessScore(b) - completenessScore(a);
   return a.name.localeCompare(b.name);
 });
}


// ─── Step 7 – greedy slot filling ─────────────────────────────────────────────
// Select foods for one slot, honouring the SmartCalorie budget.
// dayOffset rotates the eligible pool to generate variety across 7 days.
function selectFoodsForSlot(slot, pool, scBudget, usedFoodIds, dayOffset, healthConditions, communityCodes = []) {
  const lunchDinnerSlot = slot.index === 4 || slot.index === 7;
  const typeSet = new Set(slot.typeCodes.filter(code => !(lunchDinnerSlot && code === 'P')));
  const coreSlot = CORE_SLOT_INDICES.has(slot.index);


  let eligible = pool.filter(f => {
    if (usedFoodIds.has(f._id)) return false;
    return f.typeArr.some(t => typeSet.has(t)) && isSlotAppropriateFood(slot, f);
  });
  const primaryEligible = eligible.filter(f => PRIMARY_SOURCES.has(f.source));
  const secondaryEligible = eligible.filter(f => SECONDARY_SOURCES.has(f.source));
  const tertiaryEligible = eligible.filter(f => TERTIARY_SOURCES.has(f.source));
  const commercialEligible = eligible.filter(f => COMMERCIAL_SOURCES.has(f.source));


  if (coreSlot) {
    const primaryMeals = primaryEligible.filter(isCoreMealFriendlyFood);
    const secondaryMeals = secondaryEligible.filter(isCoreMealFriendlyFood);
    const tertiaryMeals = tertiaryEligible.filter(isCoreMealFriendlyFood);
    eligible = primaryMeals.length > 0
      ? primaryMeals
      : secondaryMeals.length > 0
        ? secondaryMeals
        : tertiaryMeals.length > 0
          ? tertiaryMeals
          : primaryEligible.length > 0
            ? primaryEligible.filter(f => !f.isCondiment)
            : secondaryEligible.length > 0
              ? secondaryEligible.filter(f => !f.isCondiment)
              : tertiaryEligible.length > 0
                ? tertiaryEligible.filter(f => !f.isCondiment)
                : commercialEligible.filter(f => !f.isCondiment && !CONDIMENT_RE.test(f.name));
    if (lunchDinnerSlot) {
      const lunchDinnerEligible = eligible.filter(isLunchDinnerMealFood);
      if (lunchDinnerEligible.length > 0) eligible = lunchDinnerEligible;
    }
  } else {
    eligible = [...primaryEligible, ...secondaryEligible, ...tertiaryEligible, ...commercialEligible].filter(f => isSlotAppropriateFood(slot, f));
  }


 eligible = sortByPriorityAndScore(eligible, healthConditions, scBudget, communityCodes);


 // Rotate by dayOffset after ranking so high-quality foods still lead, but days vary.
 if (dayOffset > 0 && eligible.length > 1) {
   const off = (dayOffset * 31) % eligible.length;
   eligible = [...eligible.slice(off), ...eligible.slice(0, off)];
 }


 const selected = [];
 let scAccum    = 0;


 for (const food of eligible) {
   if (selected.length >= slot.maxItems) break;
   if (food.smartCalories <= 0) continue;
   if (coreSlot && selected.length === 0 && food.isCondiment) continue;
   // Allow up to 120% of budget so slots aren't chronically under-filled
   if (scAccum + food.smartCalories <= scBudget * 1.2) {
     selected.push(food);
     scAccum += food.smartCalories;
     usedFoodIds.add(food._id);
     if (scAccum >= scBudget * 0.8) break; // 80% fill → good enough
   }
 }


 // Fallback: always add at least one food per active slot
 if (selected.length === 0 && eligible.length > 0) {
   const fallback = coreSlot ? (eligible.find(f => !f.isCondiment) || eligible[0]) : eligible[0];
   selected.push(fallback);
   usedFoodIds.add(fallback._id);
 }


 return selected;
}


// ─── Snapshot helper ──────────────────────────────────────────────────────────
function foodSnapshot(f) {
 return {
   foodId:        f._id,
   source:        f.source,
   detailSource:  f.detailSource || f.source,
   name:          f.name,
   calories:      f.calories,
   smartCalories: f.smartCalories,
   score:         f.score,
   protein:       f.protein,
   carbs:         f.carbs,
   fat:           f.fat,
   fiber:         f.fiber,
   portion:       f.portion,
   portionUnit:   f.portionUnit,
   imageId:       f.imageId,
   foodType:      f.foodType,
   nutriScore:    f.nutriScore,
   brandName:     f.brandName,
   recipe:        f.recipe,
   steps:         f.steps,
   video:         f.video,
   remark:        f.remark,
   sourceUrl:     f.sourceUrl,
   recommendedIn: f.recommendedIn,
   avoidIn:       f.avoidIn,
   hasRecipe:     f.hasRecipe,
   hasSteps:      f.hasSteps,
   hasVideo:      f.hasVideo,
   hasImage:      f.hasImage,
   isFallbackSource: f.isFallbackSource,
   isConsumed:    false,
   consumedAt:    null,
 };
}

async function enrichWithRecipeDetails(food) {
 if (!food || food.source === 'food_recipes') return food;

 const escapedName = String(food.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 if (!escapedName) return food;

 const recipeRaw = await FoodRecipe.findOne({
   $or: [
     { Name: { $regex: `^${escapedName}$`, $options: 'i' } },
     { foodItem: { $regex: `^${escapedName}$`, $options: 'i' } },
   ],
 }).lean();

 if (!recipeRaw) return food;

 const recipeFood = normalizeFood(recipeRaw, 'food_recipes');
 if (!recipeFood) return food;

 return {
   ...food,
   recipe: recipeFood.recipe || food.recipe,
   steps: recipeFood.steps || food.steps,
   video: recipeFood.video || food.video,
   remark: recipeFood.remark || food.remark,
   recommendedIn: recipeFood.recommendedIn?.length ? recipeFood.recommendedIn : food.recommendedIn,
   avoidIn: recipeFood.avoidIn?.length ? recipeFood.avoidIn : food.avoidIn,
   sourceUrl: recipeFood.sourceUrl || food.sourceUrl,
   hasRecipe: recipeFood.hasRecipe || food.hasRecipe,
   hasSteps: recipeFood.hasSteps || food.hasSteps,
   hasVideo: recipeFood.hasVideo || food.hasVideo,
   detailSource: 'food_recipes',
 };
}


function buildValidationWarnings(planDays, activeIdxSet, calorieTarget, smartCalTarget) {
 const warnings = new Set();
 for (const day of planDays) {
   const activeSlots = day.slots.filter(s => activeIdxSet.has(s.slotIndex));
   for (const slot of activeSlots) {
     if (!slot.foods.length) warnings.add(`${day.dayLabel}: ${slot.slotName} has no foods assigned.`);
     const onlyFallback = slot.foods.length > 0 && slot.foods.every(f => f.isFallbackSource);
     if (onlyFallback) warnings.add(`${day.dayLabel}: ${slot.slotName} used fallback sources only.`);
     const coreCondimentOnly = CORE_SLOT_INDICES.has(slot.slotIndex) && slot.foods.length > 0 && slot.foods.every(f => CONDIMENT_RE.test(f.name));
     if (coreCondimentOnly) warnings.add(`${day.dayLabel}: ${slot.slotName} appears condiment-only.`);
     if (slot.foods.some(f => f.source === 'food_recipes' && !f.hasRecipe && !f.hasSteps)) {
       warnings.add(`${day.dayLabel}: ${slot.slotName} includes recipe items missing recipe steps.`);
     }
   }
   const totalCalories = activeSlots.reduce((s, sl) => s + sl.totalCalories, 0);
   const totalSmartCalories = activeSlots.reduce((s, sl) => s + sl.totalSmartCalories, 0);
   if (calorieTarget && totalCalories < calorieTarget * 0.65) warnings.add(`${day.dayLabel}: calories are under target.`);
   if (smartCalTarget && totalSmartCalories < smartCalTarget * 0.65) warnings.add(`${day.dayLabel}: SmartCalories are under target.`);
 }
 return [...warnings];
}


function sourceStatsFromPlan(planDays) {
 const stats = {};
 for (const day of planDays) {
   for (const slot of day.slots) {
     for (const food of slot.foods) stats[food.source] = (stats[food.source] || 0) + 1;
   }
 }
 return stats;
}


function filteredNormalizedFoods(rawGroups, profile, sources) {
 const rawPool = [];
 for (const source of sources) {
   for (const raw of rawGroups[source] || []) {
     const normalized = normalizeFood(raw, source);
     if (normalized && hasCriticalFields(normalized)) rawPool.push(normalized);
   }
 }
 return dedupeFoods(rawPool)
   .filter(f => passesCommunityFilter(f, profile.communityCodes))
   .filter(f => passesConditionsFilter(f, profile.healthConditions))
   .filter(f => passesAllergyFilter(f, profile.allergies));
}


async function loadFoodGroups(dietType) {
 const dtFilter  = buildDietTypeFilter(dietType);
 const [catFoods, recipeFoods, homeFoods, packFoods, restFoods] = await Promise.all([
   FoodByCat.find(dtFilter).lean(),
   FoodRecipe.find(dtFilter).lean(),
   HomeBased.find(dtFilter).lean(),
   Packaged.find(dtFilter).lean(),
   Restaurant.find(dtFilter).lean(),
 ]);
 return {
   food_by_cat: catFoods,
   food_recipes: recipeFoods,
   homeBased: homeFoods,
   Packaged: packFoods,
   restaurants: restFoods,
 };
}


// ─── Public: generate 7-day plan ──────────────────────────────────────────────
async function generatePlan(profile) {
 const {
   gender, age, heightCm, weightKg,
   activityCode, goal,
   dietType, communityCodes, healthConditions, allergies, mealsPerDay,
 } = profile;


 // Step 1: calorie targets
 const bmr              = computeBMR({ gender, weightKg, heightCm, age });
 const tdee             = computeTDEE(bmr, activityCode);
 const calorieTarget    = computeCalorieTarget(tdee, goal);
 const smartCalTarget   = computeSmartCalorieTarget(calorieTarget);


 // Step 2: active slots
 const activeIdxSet     = new Set(getActiveSlotIndices(mealsPerDay));
 const activeSlots      = SLOT_CONFIG.filter(s => activeIdxSet.has(s.index));
 const totalWeight      = activeSlots.reduce((s, sl) => s + sl.scWeight, 0);
 const slotBudget       = {};
 for (const sl of activeSlots) {
   slotBudget[sl.index] = (sl.scWeight / totalWeight) * smartCalTarget;
 }


 // Step 3-6: load food pool, keeping recipes/home-based as the primary sources.
 const rawGroups = await loadFoodGroups(dietType);
 const sortedPool = sortByPriorityAndScore(
   filteredNormalizedFoods(rawGroups, { communityCodes, healthConditions, allergies }, [
     'food_recipes',
     'homeBased',
     'food_by_cat',
     'Packaged',
     'restaurants',
   ]),
   healthConditions,
   null,
   communityCodes
 );


 // Step 7: build 7-day plan
 const planDays = [];
 for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
   const usedFoodIds = new Set();
   const slots = [];
   let carriedSmartCalories = 0;


   for (const slot of SLOT_CONFIG) {
     const isActive = activeIdxSet.has(slot.index);
     let   foods    = [];


     if (isActive) {
       const budgetForSlot = (slotBudget[slot.index] || 0) + carriedSmartCalories;
       foods = selectFoodsForSlot(slot, sortedPool, budgetForSlot, usedFoodIds, dayIdx, healthConditions, communityCodes);
       const usedSmartCalories = foods.reduce((s, f) => s + f.smartCalories, 0);
       carriedSmartCalories = Math.max(0, budgetForSlot - usedSmartCalories);
     }


     slots.push({
       slotIndex:         slot.index,
       slotName:          slot.name,
       mealTime:          slot.time,
       isActive,
       foods:             foods.map(foodSnapshot),
       totalSmartCalories: parseFloat(foods.reduce((s, f) => s + f.smartCalories, 0).toFixed(2)),
       totalCalories:      Math.round(foods.reduce((s, f) => s + f.calories, 0)),
       totalProtein:       parseFloat(foods.reduce((s, f) => s + f.protein, 0).toFixed(1)),
       totalCarbs:         parseFloat(foods.reduce((s, f) => s + f.carbs, 0).toFixed(1)),
       totalFat:           parseFloat(foods.reduce((s, f) => s + f.fat, 0).toFixed(1)),
       totalFiber:         parseFloat(foods.reduce((s, f) => s + f.fiber, 0).toFixed(1)),
     });
   }


   planDays.push({ dayIndex: dayIdx, dayLabel: `Day ${dayIdx + 1}`, slots });
 }


 const validationWarnings = buildValidationWarnings(planDays, activeIdxSet, calorieTarget, smartCalTarget);
 return {
   bmr,
   tdee,
   calorieTarget,
   smartCalorieTarget: smartCalTarget,
   planDays,
   validationWarnings,
   sourceStats: sourceStatsFromPlan(planDays),
 };
}


// ─── Public: swap options for a slot ──────────────────────────────────────────
// Returns top 50 eligible foods for a slot given the user's profile filters.
async function getSwapOptions(slotIndex, profile, dayIndex = 0) {
  const slot = SLOT_CONFIG[slotIndex];
  if (!slot) throw new Error(`Invalid slot index: ${slotIndex}`);
  const lunchDinnerSlot = slot.index === 4 || slot.index === 7;


 const rawGroups = await loadFoodGroups(profile.dietType);
 const rawPool = filteredNormalizedFoods(rawGroups, profile, [
   'food_recipes',
   'homeBased',
   'food_by_cat',
   'Packaged',
   'restaurants',
 ]);


  const typeSet = new Set(slot.typeCodes.filter(code => !(lunchDinnerSlot && code === 'P')));
  let filtered = rawPool
    .filter(f => passesCommunityFilter(f, profile.communityCodes))
    .filter(f => passesConditionsFilter(f, profile.healthConditions))
    .filter(f => passesAllergyFilter(f, profile.allergies))
    .filter(f => f.typeArr.some(t => typeSet.has(t)))
    .filter(f => isSlotAppropriateFood(slot, f));

  if (CORE_SLOT_INDICES.has(slot.index)) {
    const primaryMeals = filtered.filter(f => PRIMARY_SOURCES.has(f.source) && isCoreMealFriendlyFood(f));
    const secondaryMeals = filtered.filter(f => SECONDARY_SOURCES.has(f.source) && isCoreMealFriendlyFood(f));
    filtered = primaryMeals.length > 0
      ? primaryMeals
      : secondaryMeals.length > 0
        ? secondaryMeals
        : filtered.filter(f => PRIMARY_SOURCES.has(f.source) && !f.isCondiment);
  }

  if (lunchDinnerSlot) {
    const lunchDinnerFiltered = filtered.filter(isLunchDinnerMealFood);
    if (lunchDinnerFiltered.length > 0) filtered = lunchDinnerFiltered;
  }

  let options = sortByPriorityAndScore(filtered, profile.healthConditions, null, profile.communityCodes)
    .filter(f => !CONDIMENT_RE.test(f.name))
    .filter(f => !(CORE_SLOT_INDICES.has(slot.index) && String(f.brandName || '').trim() && f.source === 'food_by_cat'));

  if (dayIndex > 0 && options.length > 1) {
    const off = (dayIndex * 17) % options.length;
    options = [...options.slice(off), ...options.slice(0, off)];
  }

  return options
    .slice(0, 60)
    .map(foodSnapshot);
}


async function getFoodDetails(source, foodId, profile = null, slotIndex = null) {
 const modelBySource = {
   food_by_cat: FoodByCat,
   food_recipes: FoodRecipe,
   homeBased: HomeBased,
   Packaged,
   restaurants: Restaurant,
 };
 const Model = modelBySource[source];
 if (!Model || !foodId) return null;


 const foodIdText = String(foodId).trim();
 const numericFoodId = Number(foodIdText);
 const idFilters = [{ code: foodIdText }];
 if (source !== 'food_recipes' || /^[a-f\d]{24}$/i.test(foodIdText)) {
   idFilters.push({ _id: foodIdText });
 }
 if (!Number.isNaN(numericFoodId)) {
   idFilters.push({ code: numericFoodId });
   if (source !== 'food_recipes') idFilters.push({ _id: numericFoodId });
 }


 const raw = await Model.findOne({
   $or: idFilters,
 }).lean();
 if (!raw) return null;


 let food = normalizeFood(raw, source);
 if (!food) return null;
 food = await enrichWithRecipeDetails(food);
 let alternatives = [];
 if (profile && slotIndex !== null && slotIndex !== undefined) {
   alternatives = (await getSwapOptions(Number(slotIndex), profile))
     .filter(option => String(option.foodId) !== String(foodId))
     .slice(0, 12);
 }
 return { food: foodSnapshot(food), alternatives };
}

async function searchFoods(profile, q, slotIndex = null) {
  const rawGroups = await loadFoodGroups(profile.dietType);
  let pool = filteredNormalizedFoods(rawGroups, profile, [
    'food_recipes',
   'homeBased',
   'food_by_cat',
   'Packaged',
   'restaurants',
 ]);

 if (slotIndex !== null && slotIndex !== undefined && !Number.isNaN(Number(slotIndex))) {
   const slot = SLOT_CONFIG[Number(slotIndex)];
   if (slot) {
     const typeSet = new Set(slot.typeCodes);
      pool = pool
        .filter(f => f.typeArr.some(t => typeSet.has(t)))
        .filter(f => isSlotAppropriateFood(slot, f));
    }
  }

  const query = String(q || '').trim().toLowerCase();
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const regex = new RegExp(queryTokens.join('.*'), 'i');
  const filtered = pool.filter(f => regex.test(f.name) || regex.test(f.brandName || ''));

  const relevanceScore = (food) => {
    const name = String(food.name || '').toLowerCase();
    const brand = String(food.brandName || '').toLowerCase();
    const haystack = `${name} ${brand}`.trim();
    let score = 0;

    if (name === query) score += 120;
    else if (name.startsWith(query)) score += 80;
    else if (name.includes(query)) score += 60;
    else if (brand.startsWith(query)) score += 30;
    else if (brand.includes(query)) score += 20;

    for (const token of queryTokens) {
      if (name.split(/[^a-z0-9]+/).includes(token)) score += 18;
      else if (name.includes(token)) score += 10;
      if (brand.split(/[^a-z0-9]+/).includes(token)) score += 6;
      else if (brand.includes(token)) score += 3;
    }

    if (CONDIMENT_RE.test(name)) score -= 40;
    if (PRIMARY_SOURCES.has(food.source)) score += 20;
    else if (SECONDARY_SOURCES.has(food.source)) score += 10;
    else if (COMMERCIAL_SOURCES.has(food.source)) score -= 5;
    if (food.source === 'food_recipes' && (food.hasRecipe || food.hasSteps)) score += 12;
    if (haystack.includes(query)) score += 4;

    return score;
  };

  return filtered
    .slice()
    .sort((a, b) => {
      const relDiff = relevanceScore(b) - relevanceScore(a);
      if (relDiff !== 0) return relDiff;
      const ranked = sortByPriorityAndScore([a, b], profile.healthConditions, null, profile.communityCodes);
      return ranked[0] === a ? -1 : 1;
    })
    .slice(0, 40)
    .map(foodSnapshot);
}


module.exports = {
 generatePlan,
 getSwapOptions,
 getFoodDetails,
 SLOT_CONFIG,
 getActiveSlotIndices,
 normalizeFood,
 sortByPriorityAndScore,
 searchFoods,
};



