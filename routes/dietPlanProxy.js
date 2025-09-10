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
const TAILORED_IMG =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Untitled_design_6_2.png?v=1757500742";
const TAILORED_BG =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_1379.png?v=1757501741";

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
  if (!heightCm || !weightKg) return "";
  const h = Number(heightCm) / 100;
  if (!h) return "";
  return String(round1(Number(weightKg) / (h * h)));
}
function fmtOrDash(v, unit = "") {
  if (v === 0) return "0" + (unit ? ` ${unit}` : "");
  if (!v && v !== 0) return "—";
  return `${v}${unit ? ` ${unit}` : ""}`;
}
function niceList(arr = []) {
  const a = arr.map((s) => String(s || "").trim()).filter(Boolean);
  if (!a.length) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}

// Extract optional HH:MM time and split main/note
function parseMeal(raw) {
  const out = { time: "", main: "", note: "" };
  if (!raw) return out;
  const s = String(raw);
  const t = s.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  out.time = t ? t[0] : "";
  const cleaned = t ? s.replace(t[0], "").trim() : s.trim();
  const parts = cleaned.split(/\r?\n+/);
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

function basicDetailsHtml({ name = "—", phone = "—", age = "", height = "", weight = "", bmi = "" }) {
  return `
<section class="page details tall">
  <div class="details-card">
    <div class="pin"></div>
    <h2>BASIC DETAILS</h2>
    <div class="rows">
      <div class="row"><div class="dt">Name</div><div class="dd">${escapeHtml(name)}</div></div>
      <div class="row"><div class="dt">Contact</div><div class="dd">${escapeHtml(phone)}</div></div>
      <div class="row"><div class="dt">Age</div><div class="dd">${escapeHtml(fmtOrDash(age))}</div></div>
      <div class="row"><div class="dt">Height</div><div class="dd">${escapeHtml(fmtOrDash(height, "cm"))}</div></div>
      <div class="row"><div class="dt">Weight</div><div class="dd">${escapeHtml(fmtOrDash(weight, "kg"))}</div></div>
      <div class="row"><div class="dt">BMI</div><div class="dd">${escapeHtml(bmi || "—")}</div></div>
    </div>
  </div>
</section>`;
}

// ---- PAGE 3+ (DAY) — no background image here & no min-height ----
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
        const mealTime = (times && times[m]) ? String(times[m]).trim() : parsed.time;
        return `
      <div class="mealrow">
        <div class="left">
          <div class="mealname">${m}</div>
        </div>
        <div class="rightcol">
          <div class="meal-main">${escapeHtml(parsed.main || "—")}</div>
          ${
            mealTime
              ? `<div class="time-under">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  ${escapeHtml(mealTime)}
                </div>`
              : ""
          }
          ${parsed.note ? `<div class="meal-note">${escapeHtml(parsed.note)}</div>` : ""}
          <div class="sep"></div>
        </div>
      </div>`;
      }).join("")}
    </div>
  </div>
</section>`;
}

// ---- Tailored Diet slide (ALWAYS LAST) ----
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
    <div class="bowl-wrap">
      <img src="${TAILORED_IMG}" alt="" />
    </div>
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

// ---------- CSS ----------
const CSS = `
:root{
  --green:#2f7a2f;
  --green-700:#225f22;
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
/* Slides 1–2 and Tailored slide get A4 height */
.tall{ min-height:297mm; }

/* ---- COVER (with BG image) ---- */
.cover{ background:url("${BG_COVER}") center/cover no-repeat; }
.cover-card{
  width:100%; max-width:600px;
  background:linear-gradient(180deg,#3a8a33 0%, #2b6e27 100%);
  border-radius:28px; padding:32px 28px; text-align:center; color:#fff;
  box-shadow:0 18px 40px rgba(0,0,0,.25);
}
.cover-card h1{
  margin:0 0 10px; line-height:1.2; font-weight:800; letter-spacing:.3px;
  text-transform:uppercase; font-size:28px;
}
.rule{ height:1px; width:78%; margin:12px auto 14px; background:rgba(255,255,255,.28); }
.subtitle{ margin:0 0 22px; font-size:15px; line-height:1.5; color:#ebffeb; }
.cta-pill{
  display:inline-block; background:#fff; border-radius:12px; padding:14px 18px;
  color:var(--green-700); min-width:280px; box-shadow:0 4px 14px rgba(0,0,0,.18);
}
.pill-title{ font-weight:800; font-size:18px; text-align:center; }
.pill-sub{ color:#2a532a; font-size:13px; text-align:center; margin-top:6px; }

/* ---- DETAILS (with BG image) ---- */
.details{ background:url("${BG_DETAILS}") center/cover no-repeat; }
.details-card{
  position:relative; width:100%; max-width:620px; background:#fff;
  border-radius:20px; padding:24px 26px 18px;
  box-shadow:0 12px 40px rgba(0,0,0,.18); border:1px solid #e6f0e6;
}
.pin{
  position:absolute; width:42px; height:42px; top:-21px; left:50%;
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
  border:12px solid var(--green);       /* outer dark */
  border-radius:6px; padding:6px;       /* space between frames */
}
.sheet-inner{
  border:6px solid var(--green-light);  /* inner light */
  border-radius:2px; background:#fff;
  padding:10px;                         /* compact */
}

/* Header bar */
.topbar{
  display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center;
  background:#e7f2de; border:1px solid #d1e5c7;
  border-radius:4px; padding:10px 12px; margin-bottom:10px;
}
.cell{ font-size:14px; }
.mid{ text-align:center; }
.right{ text-align:right; color:#2d2d2d; }
.strong{ font-weight:800; color:#2b6a2b; }

/* Meal rows */
.mealrow{
  display:grid; grid-template-columns:180px 1fr; gap:12px; align-items:flex-start;
  margin-top:6px;
}
.left{ display:flex; flex-direction:column; align-items:flex-start; }
.mealname{ font-weight:800; color:#2b6a2b; line-height:1; }

.rightcol{ position:relative; }
.meal-main{ color:#1e1e1e; font-size:14px; line-height:1.45; }

/* time under meal (right column) */
.time-under{
  display:flex; align-items:flex-start; gap:8px;
  color:#2b2b2b; font-size:13px; line-height:1; margin-top:6px;
}
.time-under svg{ width:15px; height:15px; opacity:.95; margin-top:1px; }

.meal-note{ color:#5a5a5a; font-size:13px; line-height:1.45; font-style:italic; margin-top:6px; }

/* Green separator */
.sep{
  height:3px; background:#2f7a2f; width:100%;
  margin:12px 0 6px;
}

/* Monthly */
.slot h3{ margin:0 0 6px; color:#2f7a2f; }
.time-inline{ color:#666; font-weight:500; }
.opts{ margin:0; padding-left:18px; }
.dash{ color:#888; }

/* ---- Tailored Diet slide ---- */
/* Use your full-bleed background image; no extra green background */
.tailor{
  background:url("${TAILORED_BG}") center/cover no-repeat;
}
.tailor-card{
  position:relative; width:100%; max-width:560px;
  background:linear-gradient(180deg,#3a8a33 0%, #2b6e27 100%);
  color:#fff; border-radius:28px; padding:28px 26px 120px; /* extra bottom for bowl overlap */
  box-shadow:0 18px 40px rgba(0,0,0,.22);
  text-align:center;
}
.tailor-card h2{
  margin:0; font-size:28px; line-height:1.2; font-weight:800; letter-spacing:.2px;
}
.t-rule{ height:1px; background:rgba(255,255,255,.35); width:80%; margin:12px auto 14px; }
.t-msg{ margin:0; font-size:14px; line-height:1.6; color:#f4fff4; }
.bowl-wrap{
  position:absolute; left:50%; bottom:-20px; transform:translateX(-50%);
  width:92%; pointer-events:none;
}
.bowl-wrap img{ width:100%; height:auto; display:block; }

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

    // 2) Enrich from Lead if available
    let custName = doc.customer?.name || "";
    let custPhone = doc.customer?.phone || "";
    if (doc.customer?.leadId) {
      try {
        const lead = await Lead.findById(doc.customer.leadId).lean();
        if (lead) {
          custName = lead.name || custName || "Customer";
          custPhone = lead.contactNumber || custPhone || "—";
        }
      } catch {}
    }
    custName = custName || "Customer";
    custPhone = custPhone || "—";

    // Health profile for slide 2
    const hp = doc.healthProfile || {};
    const bmiValue = hp.bmi || computeBMI(hp.heightCm, hp.weightKg);

    // 3) Build pages
    const planType = doc.planType || "Weekly";
    const start = doc.startDate ? new Date(doc.startDate) : new Date();
    const duration = Number(doc.durationDays || (planType === "Weekly" ? 14 : 30));

    const pages = [];

    // Slide 1
    pages.push(coverPageHtml({ whenText: prettyDDMonthYYYY(start), doctorText: "" }));

    // Slide 2
    pages.push(
      basicDetailsHtml({
        name: custName,
        phone: custPhone,
        age: hp.age,
        height: hp.heightCm,
        weight: hp.weightKg,
        bmi: bmiValue,
      })
    );

    // Slide 3+ (weekly or monthly)
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

    // ALWAYS append Tailored Diet slide at the very end
    pages.push(
      tailoredDietHtml({
        conditions: Array.isArray(doc.conditions) ? doc.conditions : [],
        goals: Array.isArray(doc.healthGoals) ? doc.healthGoals : [],
      })
    );

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
