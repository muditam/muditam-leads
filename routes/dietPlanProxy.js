// routes/dietPlanProxy.js
const express = require("express");
const router = express.Router();

const DietPlan = require("../models/DietPlan");
const Lead = require("../models/Lead"); // ← to fetch name & phone

// ---------- helpers ----------
const BG_URL =
  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Untitled_design_3_3.png?v=1757425422";

const MEALS = ["Breakfast", "Lunch", "Snacks", "Dinner"];
const MONTHLY_SLOTS = ["Breakfast", "Lunch", "Evening Snack", "Dinner"];

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
function addDays(dateObj, n) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + n);
  return d;
}
function weekday(d) {
  try {
    return new Date(d).toLocaleDateString("en-US", { weekday: "long" });
  } catch {
    return "";
  }
}

// ---------- HTML builders ----------
function coverPageHtml({ whenText = "", doctorText = "" }) {
  return `
  <section class="page cover">
    <div class="cover-card">
      <h1>DIETARY ROADMAP TO<br/>HEALTHY LIFESTYLE</h1>
      <p class="subtitle">Starting is the hardest part<br/>Congratulations on taking the leap!</p>
      <div class="pill">
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
      <h2>BASIC DETAILS</h2>
      <div class="dl">
        <div class="row"><span class="dt">Name</span><span class="dd">${escapeHtml(name)}</span></div>
        <div class="row"><span class="dt">Contact</span><span class="dd">${escapeHtml(phone)}</span></div>
      </div>
    </div>
  </section>`;
}

function dayPageHtml({ dayIndex, dateIso, meals }) {
  return `
  <section class="page day">
    <div class="day-card">
      <div class="day-head">
        <div class="chip">DAY ${dayIndex + 1}</div>
        <div class="wday">${escapeHtml(weekday(dateIso))}</div>
        <div class="date">${escapeHtml(isoYYYYMMDD(dateIso))}</div>
      </div>
      ${MEALS.map((m) => {
        const val = meals[m] || "";
        return `
          <div class="meal">
            <div class="meal-title">${m}</div>
            <div class="meal-body">${escapeHtml(val || "—")}</div>
          </div>`;
      }).join("")}
    </div>
  </section>`;
}

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
  <section class="page monthly">
    <div class="monthly-card">
      <h2>MONTHLY OPTIONS</h2>
      ${blocks}
    </div>
  </section>`;
}

// ---------- CSS ----------
const CSS = `
  :root { --green:#2f7a2f; --green-700:#2b6a2b; --ink:#111; --muted:#666; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#f6f7f9; color:var(--ink); font-family: system-ui, -apple-system, "Poppins", Segoe UI, Roboto, Arial, sans-serif; }
  .page {
    width: 210mm; min-height: 297mm; margin: 0 auto 18px;
    background-image: url("${BG_URL}");
    background-size: cover; background-position: center; background-repeat: no-repeat;
    display:flex; align-items:center; justify-content:center; padding: 22mm 16mm;
    page-break-after: always;
  }
  .cover .cover-card {
    width: 100%; max-width: 600px; background: rgba(255,255,255,0.92);
    border-radius: 24px; padding: 32px 28px; text-align:center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.07);
  }
  .cover h1 {
    font-size: 34px; line-height: 1.15; margin: 0 0 10px; color:#184a18; font-weight: 800;
    text-transform: uppercase; letter-spacing: .3px;
  }
  .cover .subtitle { margin: 0 0 18px; color:#2b2b2b; }
  .pill { display:inline-block; background:#fff; border-radius:16px; padding:10px 16px; border:1px solid #e8e8e8; }
  .pill-title { font-weight:700; color:#3b7f3b; }
  .pill-sub { font-size: 13px; color:#444; }

  .details .details-card, .monthly .monthly-card, .day .day-card {
    width: 100%; background: #fff; border-radius: 18px; padding: 18px;
    border: 2px solid #d8ead8; box-shadow: 0 2px 10px rgba(0,0,0,.06);
  }
  .details h2, .monthly h2 { text-align:center; color:#2f7a2f; margin: 6px 0 12px; letter-spacing:.2px; }
  .details .dl { margin-top: 6px; }
  .details .row { display:flex; gap:12px; border-bottom:1px dashed #eee; padding:10px 4px; }
  .details .dt { min-width: 120px; font-weight:700; color:#2f7a2f; }
  .details .dd { color:#222; }

  .day .day-card { padding: 14px; }
  .day .day-head { display:grid; grid-template-columns: 1fr 1fr 1fr; align-items:center; gap:8px; margin-bottom: 10px; }
  .chip { background:#eef7ee; border:1px solid #cfe6cf; color:#2f7a2f; padding:6px 10px; border-radius: 10px; font-weight:700; width:max-content; }
  .wday { text-align:center; font-weight:700; }
  .date { text-align:right; color:#444; font-weight:600; }
  .meal { padding: 10px 0; border-bottom: 1px solid #e9eee9; }
  .meal:last-child { border-bottom:none; }
  .meal-title { font-weight: 800; color:#2b6a2b; margin-bottom:4px; }
  .meal-body { color:#222; white-space:pre-wrap; }

  .monthly .slot { border:1px solid #e6efe6; border-radius:12px; padding:10px 12px; margin: 10px 0; }
  .monthly .slot h3 { margin:0 0 6px; color:#2f7a2f; }
  .monthly .slot .time { color:#666; font-weight:500; }
  .monthly .opts { margin: 0; padding-left:20px; }
  .monthly .dash { color:#888; }

  @media print {
    body { background: #fff; }
    .page { margin: 0; page-break-after: always; }
  }
`;

// ---------- ROUTE ----------
// IMPORTANT: path is just /diet-plan/:id
router.get("/diet-plan/:id", async (req, res) => {
  // If someone tries to fetch JSON, gently reject
  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(400).json({ error: "This endpoint returns HTML, not JSON." });
  }

  try {
    const planId = req.params.id;

    // 1) Fetch plan (flattened schema)
    const doc = await DietPlan.findById(planId).lean();
    if (!doc) return res.status(404).send("Diet plan not found.");

    // 2) Pull customer from Lead if available
    let custName = doc.customer?.name || "";
    let custPhone = doc.customer?.phone || "";
    if (doc.customer?.leadId) {
      try {
        const lead = await Lead.findById(doc.customer.leadId).lean();
        if (lead) {
          custName = lead.name || custName || "Customer";
          custPhone = lead.contactNumber || custPhone || "—";
        }
      } catch {
        // ignore lookup errors; fall back to plan values
      }
    }
    custName = custName || "Customer";
    custPhone = custPhone || "—";

    // 3) Build pages according to plan type
    const planType = doc.planType || "Weekly";
    const start = doc.startDate ? new Date(doc.startDate) : new Date();
    const duration = Number(doc.durationDays || (planType === "Weekly" ? 14 : 30));

    const pages = [];

    // Cover page
    pages.push(coverPageHtml({ whenText: prettyDDMonthYYYY(start), doctorText: "" }));

    // Basic details
    pages.push(basicDetailsHtml({ name: custName, phone: custPhone }));

    if (planType === "Weekly") {
      // Render up to 14 daily pages
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
      // Monthly options
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
