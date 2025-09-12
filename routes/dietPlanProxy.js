// routes/dietPlanProxy.js
const express = require("express");
const router = express.Router();

const DietPlan = require("../models/DietPlan");
const Lead = require("../models/Lead");

// ---------- constants ----------
const BG_COVER =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Untitled_design_3_3.png?v=1757425422";
const BG_DETAILS =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_1378.png?v=1757484801";
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
  // Accept either field names (heightCm/height, weightKg/weight)
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

// Keep parseMeal for notes & main text only (we won't use its time now)
function parseMeal(raw) {
  const out = { time: "", main: "", note: "" };
  if (!raw) return out;
  const s = String(raw).trim();
  const parts = s.split(/\r?\n+/);
  out.main = parts[0] || "";
  out.note = parts.slice(1).join(" ").trim();
  return out;
}

// ---------- HTML builders ----------
function coverPageHtml({ whenText = "", doctorText = "" }) {
  return `
<section class="page cover tall">
  <div class="cover-card">
    <h1>
      <span>DIETARY ROADMAP TO</span><br/>
      <span>HEALTHY LIFESTYLE</span>
    </h1>
    <div class="rule"></div>
    <p class="subtitle">
      Starting is the hardest part<br/>
      Congratulations on taking the leap!
    </p>
    <div class="cta-pill">
      <div class="pill-title">Onboarding Consultation</div>
      <div class="pill-sub">${escapeHtml(whenText)}${doctorText ? ` | ${escapeHtml(doctorText)}` : ""}</div>
    </div>
  </div>
</section>`;
}

// Only render optional rows if data present
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
  if (isPresent(bmi)) pushRow("BMI", String(bmi));

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

// ---- PAGE 3+ (DAY) — time now under meal name (left column) & raw ----
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
        // Show EXACT weekly time value as entered; no trimming/formatting; no fallback to parsed time
        const mealTimeRaw =
          times && Object.prototype.hasOwnProperty.call(times, m)
            ? String(times[m] ?? "")
            : "";

        return `
      <div class="mealrow">
        <div class="left">
          <div class="mealname">${m}</div>
          ${
            mealTimeRaw
              ? `<div class="meal-time">${escapeHtml(mealTimeRaw)}</div>`
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
  const condText = niceList(conditions) || "your condition";
  const goalText = niceList(goals) || "health goals";
  const msg = `This plan is designed to help manage your ${condText} by creating a moderate calorie deficit with balanced, low-glycemic meals. It emphasizes high-fiber foods and adjusted meal timings, including an earlier dinner, to align with your routine and improve digestion. This consistent, nutrient-dense approach will support better ${goalText} while also improving your overall wellness.`;

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
    <img src="${escapeHtml(imageUrl)}" alt="Final Slide" style="width:100%; height:auto; border-radius:8px; box-shadow:0 12px 30px rgba(0,0,0,0.12);"/>
  </div>
</section>`;
}

// Monthly page reuses the same sheet styling (no bg, no min-height)
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

/* Page: NO min-height by default (so slide 3+ can shrink). */
.page{
  width:210mm;
  margin:0 auto; page-break-after:always;
  display:flex; align-items:center; justify-content:center;
  padding:10px; /* tight edges */
}
/* Slides 1–2 + Tailored + Notes get A4 height */
.tall{ min-height:297mm; margin: 10px auto; }

/* ---- COVER (with BG image) ---- */ 
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
 
/* ---- DETAILS (with BG image) ---- */
.details{ background:url("${BG_DETAILS}") center/cover no-repeat; }
.details-card{
  position:relative; width:100%; max-width:430px; background:#fff;
  border-radius:20px; padding:38px 26px 38px;
  box-shadow:0 12px 40px rgba(0,0,0,.18); border:1px solid #e6f0e6;
}
.pin{
  position:absolute; width:62px; height:62px; top:-45px; left:50%;
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

/* ---- SHEET (DAY/MONTH) — NO background image, NO min-height ---- */
.sheet-plain{
  background:#f7f8f7; /* solid bg, no image */
}

/* Double frame */
.sheet{
  width:100%; background:#fff;
  border:8px solid var(--green);       /* outer dark */
  border-radius:6px;
}
.sheet-inner{ 
  padding:10px;                        
}

/* Header bar */
.topbar{
  display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; 
  background:#EEE2FF;  
  border-radius:4px; padding:10px 12px; margin:-10px -10px 10px -10px;
}
.cell{ font-size:14px; }
.mid{ text-align:center; }
.right{ text-align:right; color:#2d2d2d; }
.strong{ font-weight:500; color:black; }

/* Meal rows */
.mealrow{
  display:grid; grid-template-columns:180px 1fr; gap:12px; align-items:flex-start;
  margin-top:6px;
}
.left{ display:flex; flex-direction:column; align-items:flex-start; }
.mealname{ font-weight:800; line-height:1; }

/* NEW: time shown under the meal name (left column) */
.meal-time{
  margin-top:6px;
  font-size:13px;
  color:#2b2b2b;
}

.rightcol{ position:relative; }
.meal-main{ color:#1e1e1e; font-size:14px; line-height:1.45; }
.meal-note{ color:#5a5a5a; font-size:13px; line-height:1.45; font-style:italic; margin-top:6px; }

/* Separator */
.sep{
  height:2px; background:#543087; width:100%;
  margin:12px 0 6px;
}

/* Monthly */
.slot h3{ margin:0 0 6px; color:#2f7a2f; }
.time-inline{ color:#666; font-weight:500; }
.opts{ margin:0; padding-left:18px; }
.dash{ color:#888; }

/* ---- Tailored Diet slide ---- */
.tailor{
  background:url("${TAILORED_BG}") center/cover no-repeat;
}
.tailor-card{
  width:100%; max-width:560px;
  color:#fff; border-radius:28px; padding:8px 26px 150px;
  text-align:center; 
}
.tailor-card h2{
  margin:0; font-size:38px; line-height:1.2; font-weight:800; letter-spacing:.2px;
}
.t-rule{ height:1px; background:rgba(255,255,255,.35); width:80%; margin:12px auto 14px; } 
.t-msg{ margin:0; font-size:22px; line-height:1.6; color:#f4fff4; }

/* ---- Dietitian Notes slide ---- */
.notes{
  background:url("${NOTES_BG}") center/cover no-repeat; 
}
.notes-card{
  width:100%;
  max-width:520px;                 /* slimmer, taller look */
  background:linear-gradient(180deg,#7E5DAD 0%, #543087 100%);
  color:#fff;
  border-radius:28px;
  padding:32px 28px 36px;          /* comfy vertical padding */
  box-shadow:0 18px 40px rgba(0,0,0,.22);
}
.notes-card h2{
  margin:0 0 8px;
  font-size:36px;                  /* strong title */
  line-height:1.2;
  font-weight:800;
  letter-spacing:.4px;
  text-transform:uppercase;
  text-align:left;                 /* left-aligned like mock */
}
.n-rule{
  height:2px;                      /* slightly thicker */
  background:rgba(255,255,255,.55);
  width:100%;                      /* full card width */
  margin:12px 0 16px;
  border-radius:1px;
}
.notes-list{
  margin:0;
  padding-left:22px;
  list-style:disc;
  font-size:18px;                  /* readable, not huge */
  line-height:1.7;
  color:rgba(255,255,255,.9);      /* soft white text */
}

.notes-list li{
  margin:10px 0;
}

/* white bullets like the mock */
.notes-list li::marker{
  color:#ffffff;
}
/* final image slide */
.final-image img{ max-width:100%; height:auto; display:block; }

/* print */
@media print{
  body{ background:#fff; }
  .page{ margin:0; page-break-after:always; }
}
`;

// ---------- ROUTE ----------
router.get("/diet-plan/:id", async (req, res) => {
  // HTML only
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
    if (doc.customer?.leadId) {
      try {
        const lead = await Lead.findById(doc.customer.leadId).lean();
        if (lead) {
          leadDetails = lead.details || {};
          custName = lead.name || custName || "Customer";
          custPhone = lead.contactNumber || custPhone || "—";
        }
      } catch {}
    }
    custName = custName || "Customer";
    custPhone = custPhone || "—";

    // Health fields: prefer plan fields (if present), otherwise fall back to lead.details
    const planHp = doc.healthProfile || doc.details || {};
    const ageVal = planHp.age ?? leadDetails.age ?? "";
    const heightVal = planHp.heightCm ?? planHp.height ?? leadDetails.height ?? "";
    const weightVal = planHp.weightKg ?? planHp.weight ?? leadDetails.weight ?? "";
    const bmiStored = planHp.bmi ?? doc.bmi ?? "";
    const bmiValue = bmiStored || computeBMI(heightVal, weightVal) || "";

    // 3) Build pages
    const planType = doc.planType || "Weekly";
    const start = doc.startDate ? new Date(doc.startDate) : new Date();
    const duration = Number(doc.durationDays || (planType === "Weekly" ? 14 : 30));

    const pages = [];

    // Slide 1: Cover
    pages.push(coverPageHtml({ whenText: prettyDDMonthYYYY(start), doctorText: "" }));

    // Slide 2: Basic details (show only present fields)
    pages.push(
      basicDetailsHtml({
        name: custName,
        phone: custPhone,
        age: ageVal,
        height: heightVal,
        weight: weightVal,
        bmi: bmiValue,
      })
    );

    // Slide 3+ : plan content
    if (planType === "Weekly") {
      const times = doc.weeklyTimes || {};
      for (let i = 0; i < Math.min(duration, 14); i++) {
        const d = addDays(start, i);
        const meals = {
          Breakfast: (doc.fortnight?.Breakfast || [])[i] || "",
          Lunch: (doc.fortnight?.Lunch || [])[i] || "",
          Snacks: (doc.fortnight?.Snacks || [])[i] || "",
          Dinner: (doc.fortnight?.Dinner || [])[i] || "",
        };
        pages.push(dayPageHtml({ dayIndex: i, dateIso: d, meals, times }));
      }
    } else {
      const slots = {
        Breakfast: doc.monthly?.Breakfast || { time: "", options: [] },
        Lunch: doc.monthly?.Lunch || { time: "", options: [] },
        "Evening Snack": doc.monthly?.["Evening Snack"] || { time: "", options: [] },
        Dinner: doc.monthly?.Dinner || { time: "", options: [] },
      };
      pages.push(monthlyPageHtml({ slots }));
    }

    // Tailored slide (second-last)
    pages.push(
      tailoredDietHtml({
        conditions: Array.isArray(doc.conditions) ? doc.conditions : [],
        goals: Array.isArray(doc.healthGoals) ? doc.healthGoals : [],
      })
    );

    // Dietitian Notes slide (last content slide)
    pages.push(notesSlideHtml({ name: custName.split(" ")[0] || "You" }));

    // Final image slide (after notes)
    pages.push(finalImageSlideHtml({ imageUrl: FINAL_IMAGE_URL }));

    // 4) HTML
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
