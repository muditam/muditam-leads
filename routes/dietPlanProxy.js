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

// ---------- HTML builders ----------
function coverPageHtml({ whenText = "", doctorText = "" }) {
  return `
<section class="page cover">
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

function basicDetailsHtml({ name = "—", phone = "—" }) {
  return `
<section class="page details">
  <div class="details-card">
    <div class="pin"></div>
    <h2>BASIC DETAILS</h2>
    <div class="rows">
      <div class="row">
        <div class="dt">Name</div>
        <div class="dd">${escapeHtml(name)}</div>
      </div>
      <div class="row">
        <div class="dt">Contact</div>
        <div class="dd">${escapeHtml(phone)}</div>
      </div>
    </div>
  </div>
</section>`;
}

/* ---- PAGE 3+ (DAY) — compact floating card with double border ---- */
function dayPageHtml({ dayIndex, dateIso, meals }) {
  return `
<section class="page day">
  <div class="frame">
    <div class="pad">
      <div class="head">
        <div class="hcell strong">DAY ${dayIndex + 1}</div>
        <div class="hcell mid strong">${escapeHtml(weekday(dateIso))}</div>
        <div class="hcell right">${escapeHtml(isoYYYYMMDD(dateIso))}</div>
      </div>

      ${MEALS.map((m) => {
        const v = meals[m] || "";
        return `
      <div class="section">
        <div class="mealname">${m}</div>
        <div class="mealval">${escapeHtml(v || "—")}</div>
      </div>`;
      }).join("")}
    </div>
  </div>
</section>`;
}

/* ---- Monthly options reusing the same card style ---- */
function monthlyPageHtml({ slots }) {
  const blocks = MONTHLY_SLOTS.map((slot) => {
    const s = slots[slot] || { time: "", options: [] };
    const time = s.time ? ` <span class="time">(${escapeHtml(s.time)})</span>` : "";
    const opts = (s.options || []).length
      ? `<ul class="opts">${s.options.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>`
      : `<p class="dash">—</p>`;
    return `
      <div class="slot">
        <h3>${slot}${time}</h3>
        ${opts}
      </div>`;
  }).join("");

  return `
<section class="page day">
  <div class="frame">
    <div class="pad">
      <div class="head head--month">
        <div class="hcell strong">MONTHLY OPTIONS</div>
      </div>
      ${blocks}
    </div>
  </div>
</section>`;
}

// ---------- CSS (exact look to your right-hand mock) ----------
const CSS = `
:root { --green:#2f7a2f; --green-700:#236223; --ink:#111; --muted:#666; }

*{ box-sizing:border-box; }
html,body{
  margin:0; padding:0; background:#f6f7f9; color:var(--ink);
  font-family: system-ui,-apple-system,"Poppins",Segoe UI,Roboto,Arial,sans-serif;
}

/* A4 page */
.page{
  width:210mm; min-height:297mm; margin:0 auto 18px;
  display:flex; align-items:center; justify-content:center;
  padding:20mm 14mm; page-break-after:always;
}

/* ---- PAGE 1 (COVER) ---- */
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
.cover-card .rule{ height:1px; width:78%; margin:12px auto 14px; background:rgba(255,255,255,.28); }
.cover-card .subtitle{ margin:0 0 22px; font-size:15px; line-height:1.5; color:#ebffeb; }
.cta-pill{
  display:inline-block; background:#fff; border-radius:12px; padding:14px 18px;
  color:var(--green-700); min-width:280px; box-shadow:0 4px 14px rgba(0,0,0,.18);
}
.pill-title{ font-weight:800; font-size:18px; text-align:center; }
.pill-sub{ color:#2a532a; font-size:13px; text-align:center; margin-top:6px; }

/* ---- PAGE 2 (DETAILS) ---- */
.details{ background:url("${BG_DETAILS}") center/cover no-repeat; }
.details-card{
  position:relative; width:100%; max-width:620px; background:#fff;
  border-radius:20px; padding:24px 26px 18px;
  box-shadow:0 12px 40px rgba(0,0,0,.18); border:1px solid #e6f0e6;
}
.details-card .pin{
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

/* ---- PAGE 3+ (DAY/MONTH) — card layout ---- */
/* background with subtle texture and lots of open space */
.day{
  background:#f7faf7 url("${BG_DETAILS}") center/cover no-repeat;
  background-blend-mode:soft-light;
  /* Put card lower on the page like your mock */
  align-items:flex-end; justify-content:center;
  padding-top:60mm; padding-bottom:28mm;
}

/* compact floating card with double green border + drop shadow */
.frame{
  width:75%;                     /* narrower card for generous whitespace */
  border-radius:14px;
  border:10px solid #97c698;     /* light green outer ring */
  box-shadow:
    inset 0 0 0 6px #2f7a2f,     /* dark inner ring */
    0 10px 20px rgba(0,0,0,.20); /* outer shadow */
  background:transparent;
}
.pad{
  background:#fff; border-radius:8px; padding:16px 18px;
}

/* header bar inside card */
.head{
  display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center;
  background:#f1f7f1; border:1px solid #dbe7db;
  border-radius:6px; padding:10px 12px; margin-bottom:12px;
}
.head--month{ grid-template-columns:1fr; }
.hcell{ font-size:14px; }
.mid{ text-align:center; }
.right{ text-align:right; color:#444; }
.strong{ font-weight:800; color:#2b6a2b; }

/* meal sections — thin separators + bold titles */
.section{
  padding:16px 6px; border-top:1px solid #e6ede4;
}
.section:first-of-type{ border-top:1px solid #e6ede4; }
.mealname{ font-weight:800; color:#2b6a2b; margin-bottom:6px; }
.mealval{ color:#202020; line-height:1.5; font-size:14px; white-space:pre-wrap; }

/* monthly slots reuse the rhythm */
.slot{ border-top:1px solid #e6ede4; padding:16px 6px; }
.slot:first-of-type{ border-top:1px solid #e6ede4; }
.slot h3{ margin:0 0 6px; color:#2f7a2f; }
.slot .time{ color:#666; font-weight:500; }
.opts{ margin:0; padding-left:18px; }
.dash{ color:#888; }

/* print */
@media print{
  body{ background:#fff; }
  .page{ margin:0; page-break-after:always; }
}
`;

// ---------- ROUTE ----------
// Public URL (Shopify proxy mapping):  https://muditam.com/apps/consultation/diet-plan/:id
router.get("/diet-plan/:id", async (req, res) => {
  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(400).json({ error: "This endpoint returns HTML, not JSON." });
  }

  try {
    const planId = req.params.id;

    // 1) Fetch plan (flattened DietPlan schema)
    const doc = await DietPlan.findById(planId).lean();
    if (!doc) return res.status(404).send("Diet plan not found.");

    // 2) Enrich from Lead when available
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

    // 3) Build pages
    const planType = doc.planType || "Weekly";
    const start = doc.startDate ? new Date(doc.startDate) : new Date();
    const duration = Number(doc.durationDays || (planType === "Weekly" ? 14 : 30));

    const pages = [];

    // Slide 1
    pages.push(
      coverPageHtml({ whenText: prettyDDMonthYYYY(start), doctorText: "" })
    );

    // Slide 2
    pages.push(basicDetailsHtml({ name: custName, phone: custPhone }));

    // Slide 3+
    if (planType === "Weekly") {
      for (let i = 0; i < Math.min(duration, 14); i++) {
        const d = addDays(start, i);
        const meals = {
          Breakfast: (doc.fortnight?.Breakfast || [])[i] || "",
          Lunch: (doc.fortnight?.Lunch || [])[i] || "",
          Snacks: (doc.fortnight?.Snacks || [])[i] || "",
          Dinner: (doc.fortnight?.Dinner || [])[i] || "",
        };
        pages.push(dayPageHtml({ dayIndex: i, dateIso: d, meals }));
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

    // 4) Send HTML
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
