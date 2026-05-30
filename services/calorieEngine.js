'use strict';


const ACTIVITY_MULTIPLIERS = { AC1: 1.2, AC2: 1.375, AC3: 1.55, AC4: 1.7 };


// Goals that require a caloric deficit (-500 kcal)
const DEFICIT_GOALS = new Set([
 'weightLoss', 'fatShredding', 'diabetes', 'pcos', 'cholesterol',
 'hypertension', 'thyroid', 'glp1', 'uricAcid', 'heartDisease',
 'liverDisease', 'ibs',
]);


// Goals that require a caloric surplus (+300 kcal)
const SURPLUS_GOALS = new Set(['muscleGain']);


function computeBMR({ gender, weightKg, heightCm, age }) {
 const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
 return Math.round(gender === 'male' ? base + 5 : base - 161);
}


function computeTDEE(bmr, activityCode) {
 return Math.round(bmr * (ACTIVITY_MULTIPLIERS[activityCode] || 1.2));
}


function computeCalorieTarget(tdee, goal) {
 if (DEFICIT_GOALS.has(goal)) return Math.max(1200, tdee - 500);
 if (SURPLUS_GOALS.has(goal)) return tdee + 300;
 return tdee; // maintenance
}


// SmartCalorie target: proprietary satiety-weighted budget.
// Plans use the spec's Score-9 baseline ratio for the daily target.
function computeSmartCalorieTarget(calorieTarget) {
 return parseFloat((calorieTarget * 0.032).toFixed(2));
}


// Derive SmartCalories for a single food item when the field is missing
function deriveSmartCalories(calories, score) {
 const ratioMap = { 9: 0.032, 6: 0.045, 3: 0.05, 1: 0.06 };
 const ratio = ratioMap[score] || 0.05;
 return parseFloat((calories * ratio).toFixed(2));
}


module.exports = {
 computeBMR,
 computeTDEE,
 computeCalorieTarget,
 computeSmartCalorieTarget,
 deriveSmartCalories,
};



