// routes/dietPlanProxy.js
const express = require("express");
const router = express.Router();

const DietTemplate = require("../models/DietTemplate");
const DietPlan = require("../models/DietPlan");
const Lead = require("../models/Lead");
const Employee = require("../models/Employee"); // used to resolve fullName

// ---------- constants ----------
const BG_COVER =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Untitled_design_3_3.png?v=1757425422";
const BG_DETAILS =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_10_99ec1555-1334-4a43-a4e3-859eb128955b.png?v=1757756165";
const TAILORED_BG =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/A4_-_23.png?v=1757681972";
const NOTES_BG =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Untitled_design_5_2.png?v=1757502951";

// final extra image slide (after notes)
const FINAL_IMAGE_URL =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/A4_-_17.png?v=1757678833";

const MEALS = ["Breakfast", "Lunch", "Snacks", "Dinner"];
const MONTHLY_SLOTS = ["Breakfast", "Lunch", "Evening Snack", "Dinner"];

// ---------- helpers ----------
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function isoYYYYMMDD(d) {
  try {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return "—";
    return x.toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}
function prettyDDMonthYYYY(d) {
  try {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return "—";
    const dd = String(x.getDate()).padStart(2, "0");
    const month = x.toLocaleDateString("en-US", { month: "long" });
    const yyyy = x.getFullYear();
    return `${dd}-${month}-${yyyy}`;
  } catch {
    return "—";
  }
}
function weekday(d) {
  try {
    return new Date(d).toLocaleDateString("en-US", { weekday: "long" });
  } catch {
    return "";
  }
}
function addDays(dateObj, n) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + n);
  return d;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function computeBMI(heightCm, weightKg) {
  const hVal = heightCm == null ? undefined : Number(heightCm);
  const wVal = weightKg == null ? undefined : Number(weightKg);
  if (!hVal || !wVal || !isFinite(hVal) || !isFinite(wVal)) return "";
  const h = hVal / 100;
  if (!h) return "";
  return String(round1(wVal / (h * h)));
}
function fmtOrDash(v, unit = "") {
  if (v === 0) return "0" + (unit ? ` ${unit}` : "");
  if (v === "" || v == null) return "—";
  return `${v}${unit ? ` ${unit}` : ""}`;
}
function niceList(arr = []) {
  const a = arr.map((s) => String(s || "").trim()).filter(Boolean);
  if (!a.length) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}
function isPresent(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}
function cleanStringArray(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

// BMI category per requested ranges
function bmiCategory(n) {
  const b = Number(n);
  if (!isFinite(b)) return "";
  if (b < 18.5) return "Underweight";
  if (b < 25) return "Normal weight";
  if (b < 30) return "Overweight";
  if (b < 35) return "Obesity (Class I)";
  if (b < 40) return "Obesity (Class II)";
  return "Obesity (Class III / Severe obesity)";
}

// parse only main + note; time is taken from weeklyTimes
function parseMeal(raw) {
  const out = { time: "", main: "", note: "" };
  if (!raw) return out;
  const s = String(raw).trim();
  const parts = s.split(/\r?\n+/);
  out.main = parts[0] || "";
  out.note = parts.slice(1).join(" ").trim();
  return out;
}

// ----- extra helpers for robust data -----
function normalizeWeeklyTimes(wt) {
  const out = {};
  MEALS.forEach((m) => {
    out[m] = typeof wt?.[m] === "string" ? wt[m] : "";
  });
  return out;
}
function hasAnyTime(wt) {
  return MEALS.some((m) => ((wt?.[m] || "").trim().length > 0));
}
function pickFortnight(doc) {
  return doc.fortnight || doc.plan?.fortnight || {};
}
function pickMonthly(doc) {
  return doc.monthly || doc.plan?.monthly || {};
}
function pickHealthProfile(doc, leadDetails = {}) {
  const planHp = doc.healthProfile || doc.plan?.healthProfile || doc.details || {};
  return {
    age: planHp.age ?? leadDetails.age ?? "",
    height: planHp.heightCm ?? planHp.height ?? leadDetails.height ?? "",
    weight: planHp.weightKg ?? planHp.weight ?? leadDetails.weight ?? "",
    bmi: planHp.bmi ?? doc.bmi ?? "",
  };
}

// --- createdBy resolver (fullName always) ---
const isObjectIdString = (v) =>
  typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);

const isBogusName = (v) => {
  if (typeof v !== "string") return false;
  const low = v.trim().toLowerCase();
  return ["system", "admin", "root", "muditam"].includes(low);
};

/**
 * Resolve a human-readable fullName for the "created by" field.
 * Order of precedence:
 *   1) Query override (?by=Full Name)
 *   2) If createdBy is an object, prefer .fullName / .name / .email->lookup
 *   3) If createdBy is a 24-char ObjectId string -> lookup Employee by _id
 *   4) If createdBy looks like an email -> lookup Employee by email
 *   5) Otherwise assume it's already a full name
 *
 * Notes:
 * - We NEVER display email; if we can't resolve to a full name, return "".
 * - We treat placeholders like "system/admin/root/muditam" as empty.
 */
async function resolveCreatorDisplay(doc, byOverride) {
  const override = (byOverride || "").trim();
  if (override) return override;

  const rawAny = doc.createdBy ?? doc.plan?.createdBy ?? "";
  if (!rawAny) return "";

  // If an object was stored previously
  if (typeof rawAny === "object" && rawAny) {
    if (rawAny.fullName && String(rawAny.fullName).trim()) {
      const s = String(rawAny.fullName).trim();
      return isBogusName(s) ? "" : s;
    }
    if (rawAny.name && String(rawAny.name).trim()) {
      const s = String(rawAny.name).trim();
      return isBogusName(s) ? "" : s;
    }
    // Try email/id present on the object
    if (rawAny.email && String(rawAny.email).includes("@")) {
      try {
        const emp = await Employee.findOne({ email: String(rawAny.email).trim() }).lean();
        const s = emp?.fullName?.trim() || "";
        return isBogusName(s) ? "" : s;
      } catch {
        return "";
      }
    }
    if (rawAny._id && isObjectIdString(String(rawAny._id))) {
      try {
        const emp = await Employee.findById(String(rawAny._id)).lean();
        const s = emp?.fullName?.trim() || "";
        return isBogusName(s) ? "" : s;
      } catch {
        return "";
      }
    }
    return "";
  }

  // String path
  const raw = String(rawAny).trim();
  if (!raw || isBogusName(raw)) return "";

  // If it looks like an ObjectId, try findById
  if (isObjectIdString(raw)) {
    try {
      const emp = await Employee.findById(raw).lean();
      const s = emp?.fullName?.trim() || "";
      return isBogusName(s) ? "" : s;
    } catch {
      return "";
    }
  }

  // If it looks like an email, resolve to fullName (no email fallback)
  if (raw.includes("@")) {
    try {
      const emp = await Employee.findOne({ email: raw }).lean();
      const s = emp?.fullName?.trim() || "";
      return isBogusName(s) ? "" : s;
    } catch {
      return "";
    }
  }

  // Otherwise treat raw as already a full name
  return isBogusName(raw) ? "" : raw;
}

// ---------- HTML builders ----------
function coverPageHtml({ whenText = "", doctorText = "" }) {
  return `
<section class="page cover tall">
  <div class="cover-card">
    <h1>
      <span>YOUR PERSONALIZED</span><br/>  
      <span>GUIDE TO WELLNESS</span>
    </h1>
    <div class="rule"></div>
    <p class="subtitle"> Because small changes 
    <br/>create big transformations
    </p>
    <div class="cta-pill">
      <div class="pill-title">Dieteary Consultation</div> 
      <div class="pill-sub">${escapeHtml(whenText)}${doctorText ? ` | ${escapeHtml(doctorText)}` : ""}</div>
    </div>
  </div>
</section>`;
}

function basicDetailsHtml({ name = "—", phone = "—", age, height, weight, bmi }) {
  const rows = [];
  const pushRow = (label, value) =>
    rows.push(
      `<div class="row"><div class="dt">${escapeHtml(label)}</div><div class="dd">${escapeHtml(value)}</div></div>`
    );

  pushRow("Name", name || "—");
  pushRow("Contact", phone || "—");
  if (isPresent(age)) pushRow("Age", fmtOrDash(age));
  if (isPresent(height)) pushRow("Height", fmtOrDash(height, "cm"));
  if (isPresent(weight)) pushRow("Weight", fmtOrDash(weight, "kg"));
  if (isPresent(bmi)) {
    const cat = bmiCategory(bmi);
    pushRow("BMI", `${escapeHtml(String(bmi))}${cat ? ` (${escapeHtml(cat)})` : ""}`);
  }

  return `
<section class="page details tall">
  <div class="details-card">
    <div class="pin"></div>
    <h2>BASIC DETAILS</h2>
    <div class="rows">
      ${rows.join("")}
    </div>
  </div>
</section>`;
}

// ---- Title slide after 2nd slide ----
function nameTitleSlideHtml({ name = "Customer" }) {
  const raw = String(name || "").trim();
  const firstName = raw ? raw.split(/\s+/)[0] : "Customer";
  const safeName = escapeHtml(firstName);

  return `
<section class="page title talls">
  <div class="title-card" style="height:20mm; display:flex; align-items:center; justify-content:center;">
    <h2 class="big-title">${safeName}'s 14 Days Diet Plan</h2>
  </div>
</section>`;
}

// ---- PAGE 3+ (DAY) ----
function dayPageHtml({ dayIndex, dateIso, meals, times }) {
  return `
<section class="page sheet-plain">
  <div class="sheet">
    <div class="sheet-inner">
      <div class="topbar">
        <div class="cell strong">DAY ${dayIndex + 1}</div>
        <div class="cell mid strong">${escapeHtml(weekday(dateIso))}</div>
        <div class="cell right">${escapeHtml(isoYYYYMMDD(dateIso))}</div>
      </div>

      ${MEALS.map((m) => {
        const parsed = parseMeal(meals[m] || "");
        const mealTimeRaw =
          times && Object.prototype.hasOwnProperty.call(times, m)
            ? String(times[m] ?? "")
            : "";

        return `
      <div class="mealrow">
        <div class="left">
          <div class="mealname">${m}</div> 
${mealTimeRaw
  ? `
    <div class="meal-time">
      <svg class="icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M12 7v5l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>${escapeHtml(mealTimeRaw)}</span>
    </div>`
  : ""
}

        </div>
        <div class="rightcol">
          <div class="meal-main">${escapeHtml(parsed.main || "—")}</div>
          ${parsed.note ? `<div class="meal-note">${escapeHtml(parsed.note)}</div>` : ""}
        </div>
      </div>
      <div class="sep"></div>`;
      }).join("")}
    </div>
  </div>
</section>`;
}

// ---- Tailored Diet slide (SECOND-LAST) ----
function tailoredDietHtml({ conditions = [], goals = [] }) {
  const rawCond = niceList(conditions);
  const condPhrase = rawCond ? `your ${rawCond}` : "your condition";
  const goalText = niceList(goals) || "health goals";

  const msg = `This plan is designed to help manage ${condPhrase} by creating a moderate calorie deficit with balanced, low-glycemic meals. It emphasizes high-fiber foods and adjusted meal timings, including an earlier dinner, to align with your routine and improve digestion. This consistent, nutrient-dense approach will support better ${goalText} while also improving your overall wellness.`;

  return `
<section class="page tailor tall">
  <div class="tailor-card">
    <h2>TAILORED DIET CHART</h2>
    <div class="t-rule"></div>
    <p class="t-msg">${escapeHtml(msg)}</p>
  </div>
</section>`;
}

// ---- Dietitian Notes slide (ALWAYS LAST) ----
function notesSlideHtml({ name = "You" }) {
  const bullets = [
    `Stay hydrated, ${name}. Aim for 2–3 litres of water throughout the day.`,
    "Remember your 15-minute walk after lunch and dinner. It really helps with digestion and acidity.",
    "Pair this diet with your 15-minute bodyweight exercises twice a week for best results.",
    "Share the prep hacks with your household help to make following this plan easier.",
    "Enjoy your Saturday cheat meal mindfully, but get right back on track the next day.",
    "Listen to your body. The morning fatigue should reduce as your nutrition improves.",
    "Consistency is the key to managing your health. You can do this",
  ];

  return `
<section class="page notes tall">
  <div class="notes-card">
    <h2>DIETITIAN NOTES</h2>
    <div class="n-rule"></div>
    <ul class="notes-list">
      ${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
    </ul>
  </div>
</section>`;
}

// Final image slide (full-bleed image)
function finalImageSlideHtml({ imageUrl }) {
  return `
<section class="page final-image tall" style="background:#fff;">
  <div style="width:100%; max-width:800px; display:flex; align-items:center; justify-content:center; padding:18px;">
    <img src="${escapeHtml(imageUrl)}" alt="Final Slide" style="width:100%; height:auto; border-radius:8px; box-shadow:0 12px 30px rgba(0,0,0,0.12);" crossOrigin="anonymous"/>
  </div>
</section>`;
}

// Monthly page
function monthlyPageHtml({ slots }) {
  const blocks = MONTHLY_SLOTS.map((slot) => {
    const s = slots[slot] || { time: "", options: [] };
    const time = s.time ? ` <span class="time-inline">(${escapeHtml(s.time)})</span>` : "";
    const opts = (s.options || []).length
      ? `<ul class="opts">${s.options.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>`
      : `<p class="dash">—</p>`;
    return `
      <div class="slot">
        <h3>${slot}${time}</h3>
        ${opts}
        <div class="sep"></div>
      </div>`;
  }).join("");

  return `
<section class="page sheet-plain">
  <div class="sheet">
    <div class="sheet-inner">
      <div class="topbar">
        <div class="cell strong">MONTHLY OPTIONS</div>
        <div></div>
        <div></div>
      </div>
      ${blocks}
    </div>
  </div>
</section>`;
}

const CSS = `
:root{
  --green:#543087;
  --green-700:#543087;
  --green-light:#a6caa6;
  --ink:#111;
  --muted:#666;
}

*{ box-sizing:border-box; }
html,body{
  margin:0; padding:0; background:#f6f7f9; color:var(--ink);
  font-family: system-ui,-apple-system,"Poppins",Segoe UI,Roboto,Arial,sans-serif; 
}

.page{
  width:210mm;
  margin:0 auto; page-break-after:always;
  display:flex; align-items:center; justify-content:center;
  padding:10px;
}
.tall{ min-height:297mm; margin: 10px auto; }
.talls{ min-height:27mm; margin: 10px auto; }

.cover{ background:url("${BG_COVER}") center/cover no-repeat; }
.cover-card{
  width:100%; max-width:450px;
  background:linear-gradient(180deg,#7E5DAD 0%, #543087 100%);
  border-radius:28px; padding:92px 18px; text-align:center; color:#fff;
  box-shadow:0 18px 40px rgba(0,0,0,.25);
}
.cover-card h1{
  margin:0 0 10px; line-height:1.2; font-weight:800; letter-spacing:.3px;
  text-transform:uppercase; font-size:35px;
}
.rule{ height:1px; width:78%; margin:12px auto 14px; background:rgba(255,255,255,.28); }
.subtitle{ margin:0 0 22px; font-size:21px; line-height:1.5; }
.cta-pill{
  display:inline-block; background:#fff; border-radius:12px; padding:14px 18px;
  color:var(--green-700); min-width:280px; box-shadow:0 4px 14px rgba(0,0,0,.18);
}
.pill-title{ font-weight:800; font-size:25px; text-align:center; }
.pill-sub{ color:#543087; font-size:18px; text-align:center; margin-top:6px; }
 
.details{ background:url("${BG_DETAILS}") center/cover no-repeat; min-height: 180mm; } 
.details-card{
  position:relative; width:100%; max-width:430px; background:#fff;
  border-radius:20px; padding:38px 26px 38px;
  box-shadow:0 12px 40px rgba(0,0,0,.18); border:1px solid #e6f0e6;
}
.pin{
  position:absolute; width:55px; height:55px; top:-35px; left:50%;  
  transform:translateX(-50%); border-radius:50%;
  background:radial-gradient(circle at 35% 35%, #ffffff 0 35%, #dcdcdc 70%, #bdbdbd 100%);
  box-shadow:0 6px 12px rgba(0,0,0,.22);
}
.details-card h2{
  margin:4px 0 14px; text-align:center; color:var(--green); letter-spacing:.6px;
  font-weight:800; font-size:22px;
}
.rows{ margin-top:4px; }
.row{
  display:grid; grid-template-columns:140px 1fr; align-items:center;
  padding:12px 6px; border-bottom:1px dashed #e3e9e3;
} 
.row:last-child{ border-bottom:none; }
.dt{ color:var(--green); font-weight:700; }
.dd{ color:#222; }

.sheet-plain{ background:#f7f8f7; }

.sheet{
  width:100%; background:#fff;
  border:8px solid var(--green);
  border-radius:6px;
  margin: 10px 0;
}
.sheet-inner{ padding:10px; }

.topbar{
  display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; 
  background:#EEE2FF;
  border-radius:4px; padding:10px 12px; margin:-10px -10px 10px -10px;
}
.cell{ font-size:14px; }
.mid{ text-align:center; }
.right{ text-align:right; font-size:14px; } 
.strong{ font-weight:500; color:black; font-size: 20px; }

.mealrow{
  display:grid; grid-template-columns:180px 1fr; gap:12px; align-items:flex-start; 
  margin-top:6px;
}
.left{ display:flex; flex-direction:column; align-items:flex-start; }
.mealname{ font-weight:600; line-height:1; font-size: 18px; }

.meal-time{
  margin-top:6px;
  font-size:13px;
  color:#2b2b2b;
  display:flex;
  align-items:center;
  gap:6px;
}
.meal-time .icon{
  width:14px;
  height:14px;
  opacity:.85;
  flex:0 0 auto;
}

.rightcol{ position:relative; }
.meal-main{ color:#1e1e1e; font-size:20px; line-height:1.45; }
.meal-note{ color:#5a5a5a; font-size:13px; line-height:1.45; font-style:italic; margin-top:6px; }

.sep{
  height:2px; background:#543087; width:100%;
  margin:12px 0 6px; 
}

.slot h3{ margin:0 0 6px; color:#2f7a2f; }
.time-inline{ color:#666; font-weight:500; }
.opts{ margin:0; padding-left:18px; }
.dash{ color:#888; }

.tailor{ background:url("${TAILORED_BG}") center/cover no-repeat; }
.tailor-card{
  width:100%; max-width:560px;
  color:#fff; border-radius:28px; padding:8px 26px 170px;
  text-align:center; 
}
.tailor-card h2{
  margin:0; font-size:38px; line-height:1.2; font-weight:800; letter-spacing:.2px;
}
.t-rule{ height:1px; background:rgba(255,255,255,.35); width:80%; margin:12px auto 14px; } 
.t-msg{ margin:0; font-size:22px; line-height:1.6; color:#f4fff4; }

.notes{ background:url("${NOTES_BG}") center/cover no-repeat; }
.notes-card{
  position: relative;
  width:100%;
  max-width:550px;
  background: linear-gradient(180deg, rgba(126,93,173,.65) 0%, rgba(84,48,135,.65) 100%);
  color:#fff;
  border-radius:28px;
  padding:38px 30px;
  border:1px solid rgba(255,255,255,.25);
  backdrop-filter: blur(10px) saturate(120%);
  -webkit-backdrop-filter: blur(10px) saturate(120%);
  box-shadow: 0 18px 40px rgba(0,0,0,0.22);
}
.notes-card::after{
  content:"";
  position:absolute; inset:0;
  border-radius:inherit;
  pointer-events:none;
  background:
    radial-gradient(40% 35% at 15% 15%, rgba(0,0,0,.18), transparent 60%),
    radial-gradient(45% 35% at 85% 85%, rgba(0,0,0,.18), transparent 60%);
}
.notes-card h2{
  margin:0 0 8px;
  font-size:36px;
  line-height:1.2;
  font-weight:800;
  letter-spacing:.4px;
  text-transform:uppercase;
  text-align:center;
}
.n-rule{
  height:2px;
  color:rgba(255,255,255,.7);
  width:100%;
  margin:12px 0 16px;
  border-radius:1px;
}
.notes-list{
  margin:0;
  padding-left:22px;
  list-style:disc;
  font-size:18px;
  line-height:1.7;
  color:rgba(255,255,255,.95);
}
.notes-list li{ margin:10px 0; }
.notes-list li::marker{ color:#ffffff; }

.final-image img{ max-width:100%; height:auto; display:block; }

/* ---- New title slide styles ---- */
.title-card{
  width:100%;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:40px 16px;
}
.big-title{
  margin:0;
  text-align:center;
  font-size:35px;
  color:#543087;
  font-weight:800;
  letter-spacing:.2px;
}

@media print{
  body{ background:#fff; }
  .page{ margin:0; page-break-after:always; }
}

/* ---- Floating PDF button & toast ---- */
#pdfFab{
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 9999;
  background: #543087;
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 12px 16px;
  font-weight: 700;
  font-size: 14px;
  box-shadow: 0 10px 24px rgba(0,0,0,.18);
  cursor: pointer;
}
#pdfFab:disabled{ opacity:.6; cursor:not-allowed; }

#pdfToast{
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  background: #111;
  color: #fff;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  z-index: 9999;
  opacity: 0;
  pointer-events: none;
  transition: opacity .25s ease, transform .25s ease;
}
#pdfToast.show{ opacity: 1; transform: translateX(-50%) translateY(-6px); }
`;

// ---------- ROUTE ----------
router.get("/diet-plan/:id", async (req, res) => {
  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(400).json({ error: "This endpoint returns HTML, not JSON." });
  }

  try {
    const planId = req.params.id;

    // 1) Fetch plan
    const doc = await DietPlan.findById(planId).lean();
    if (!doc) return res.status(404).send("Diet plan not found.");

    // 2) Enrich from Lead if available (fall back to Lead.details)
    let custName = doc.customer?.name || "";
    let custPhone = doc.customer?.phone || "";
    let leadDetails = {};
    let leadConditions = [];
    let leadGoals = [];

    if (doc.customer?.leadId) {
      try {
        const lead = await Lead.findById(doc.customer.leadId).lean();
        if (lead) {
          leadDetails = lead.details || {};
          custName = lead.name || custName || "Customer";
          custPhone = lead.contactNumber || custPhone || "—";

          // collect possible arrays from lead (top-level or in details)
          const lc =
            (Array.isArray(lead.conditions) && lead.conditions) ||
            (Array.isArray(leadDetails.conditions) && leadDetails.conditions) ||
            [];
          const lg =
            (Array.isArray(lead.healthGoals) && lead.healthGoals) ||
            (Array.isArray(leadDetails.healthGoals) && leadDetails.healthGoals) ||
            [];

          leadConditions = cleanStringArray(lc);
          leadGoals = cleanStringArray(lg);
        }
      } catch {}
    }
    custName = custName || "Customer";
    custPhone = custPhone || "—";

    // Health fields
    const hp = pickHealthProfile(doc, leadDetails);
    const bmiValue = hp.bmi || computeBMI(hp.height, hp.weight) || "";

    // 3) Gather plan type & dates
    const planType = doc.planType || "Weekly";
    const start = doc.startDate ? new Date(doc.startDate) : new Date();
    const duration = Number(doc.durationDays || (planType === "Weekly" ? 14 : 30));

    // 4) Resolve "created by" as FULL NAME for cover pill
    const creatorDisplay = await resolveCreatorDisplay(doc, req.query.by);

    // 5) Get weekly times robustly
    let weeklyTimes =
      doc.weeklyTimes ||
      doc.plan?.weeklyTimes ||
      null;

    if (!hasAnyTime(weeklyTimes) && doc.templateId) {
      try {
        const tpl = await DietTemplate.findById(doc.templateId).lean();
        weeklyTimes = tpl?.body?.weeklyTimes || weeklyTimes;
      } catch {}
    }
    weeklyTimes = normalizeWeeklyTimes(weeklyTimes || {});

    // 6) Build pages
    const pages = [];

    // Slide 1: Cover — show "date | fullName"
    pages.push(
      coverPageHtml({
        whenText: prettyDDMonthYYYY(start),
        doctorText: creatorDisplay, // full name resolved (suppresses system/email)
      })
    );

    // Slide 2: Basic details
    pages.push(
      basicDetailsHtml({
        name: custName,
        phone: custPhone,
        age: hp.age,
        height: hp.height,
        weight: hp.weight,
        bmi: bmiValue,
      })
    );

    // ---- NEW: Slide 3 (Title slide) only for Weekly (14-day) plans
    if (planType === "Weekly") {
      pages.push(nameTitleSlideHtml({ name: custName }));
    }

    // Slide 3+ : plan content (or 4+ if weekly)
    if (planType === "Weekly") {
      const fortnight = pickFortnight(doc);
      for (let i = 0; i < Math.min(duration, 14); i++) {
        const d = addDays(start, i);
        const meals = {
          Breakfast: (fortnight?.Breakfast || [])[i] || "",
          Lunch: (fortnight?.Lunch || [])[i] || "",
          Snacks: (fortnight?.Snacks || [])[i] || "",
          Dinner: (fortnight?.Dinner || [])[i] || "",
        };
        pages.push(
          dayPageHtml({
            dayIndex: i,
            dateIso: d,
            meals,
            times: weeklyTimes,
          })
        );
      }
    } else {
      const monthly = pickMonthly(doc);
      const slots = {
        Breakfast: monthly?.Breakfast || { time: "", options: [] },
        Lunch: monthly?.Lunch || { time: "", options: [] },
        "Evening Snack": monthly?.["Evening Snack"] || { time: "", options: [] },
        Dinner: monthly?.Dinner || { time: "", options: [] },
      };
      pages.push(monthlyPageHtml({ slots }));
    }

    // Decide final conditions/goals (plan first, then lead)
    const planConds = cleanStringArray(
      Array.isArray(doc.conditions) ? doc.conditions : (doc.plan?.conditions || [])
    );
    const planGoals = cleanStringArray(
      Array.isArray(doc.healthGoals) ? doc.healthGoals : (doc.plan?.healthGoals || [])
    );

    const finalConditions = planConds.length ? planConds : leadConditions;
    const finalGoals = planGoals.length ? planGoals : leadGoals;

    // Tailored slide
    pages.push(
      tailoredDietHtml({
        conditions: finalConditions,
        goals: finalGoals,
      })
    );

    // Notes slide
    pages.push(notesSlideHtml({ name: custName.split(" ")[0] || "You" }));

    // Final image slide
    pages.push(finalImageSlideHtml({ imageUrl: FINAL_IMAGE_URL }));

    // 7) HTML
    const safeName = String(custName || "Diet Plan").trim();
    const filename = `${safeName.replace(/[\\/:*?"<>|]+/g, "_")}_DietPlan.pdf`;

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Diet Plan • ${escapeHtml(custName)}</title>
  <meta name="robots" content="noindex, nofollow"/>
  <link rel="icon" href="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam_-_Favicon.png?v=1708245689"/> 
  <style>${CSS}</style>
</head>
<body>
  ${pages.join("\n")}

  <!-- Floating Download PDF button -->
  <button id="pdfFab" type="button">Download PDF</button>
  <div id="pdfToast">Generating PDF…</div>

  <!-- Load libraries WITHOUT SRI so the browser doesn't block them if hash mismatches -->
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"
          crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"
          crossorigin="anonymous" referrerpolicy="no-referrer"></script>

  <script>
  (function(){
    const toast = document.getElementById('pdfToast');
    const fab = document.getElementById('pdfFab');
    const showToast = (msg, ms=1400) => {
      if (!toast) return;
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
    };

    function pxToMm(px){ return px * 0.264583; } // 96dpi → mm

    async function makePdf(){
      try{
        fab.disabled = true;
        showToast('Preparing slides…');

        // Ensure libs are available
        if (!window.html2canvas) throw new Error('html2canvas not loaded');
        if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF not loaded');

        // Try to set crossOrigin on images before capture (helps CORS)
        document.querySelectorAll('img').forEach(img => {
          try { if (!img.crossOrigin) img.crossOrigin = 'anonymous'; } catch(e){}
        });

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
        const pageW = 210, pageH = 297;

        const pages = Array.from(document.querySelectorAll('.page'));
        if (!pages.length) throw new Error('No slides found');

        for (let i = 0; i < pages.length; i++){
          const el = pages[i];
          showToast(\`Rendering slide \${i+1}/\${pages.length}…\`, 2000);

          // Render at higher scale for crisp output
          const canvas = await html2canvas(el, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: '#ffffff',
            scale: Math.min(2, window.devicePixelRatio || 1.5)
          });

          const imgData = canvas.toDataURL('image/jpeg', 0.95);

          // Fit to A4 while preserving aspect ratio and centering
          const imgWmm = pxToMm(canvas.width);
          const imgHmm = pxToMm(canvas.height);

          let renderW = pageW;
          let renderH = imgHmm * (pageW / imgWmm);
          if (renderH > pageH) {
            renderH = pageH;
            renderW = imgWmm * (pageH / imgHmm);
          }
          const offsetX = (pageW - renderW) / 2;
          const offsetY = (pageH - renderH) / 2;

          if (i > 0) doc.addPage('a4', 'p');
          doc.addImage(imgData, 'JPEG', offsetX, offsetY, renderW, renderH);
        }

        showToast('Downloading PDF…');
        doc.save(${JSON.stringify(filename)});
        showToast('PDF ready!');
      } catch(err){
        console.error('PDF generation failed:', err);
        alert('PDF generation failed: ' + (err && err.message ? err.message : err));
      } finally {
        fab.disabled = false;
      }
    }

    fab?.addEventListener('click', makePdf, { passive: true });
  })();
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).send(html);
  } catch (err) {
    console.error("Error in /diet-plan route:", err);
    return res.status(500).send("Internal server error");
  }
});

module.exports = router;

