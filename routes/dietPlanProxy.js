const express = require("express");
const router = express.Router();
const DietPlan = require("../models/DietPlan");

function fmtDate(iso) { /* ...same as before... */ }
function escapeHtml(s = "") { /* ...same as before... */ }

// IMPORTANT: path is just /diet-plan/:id now
router.get("/diet-plan/:id", async (req, res) => {
  // (optional) quick debug
  // console.log("Proxy hit:", req.originalUrl);

  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(400).json({ error: "This endpoint returns HTML, not JSON." });
  }

  const planId = req.params.id;
  try {
    const doc = await DietPlan.findById(planId).lean();
    if (!doc) return res.status(404).send("Diet plan not found.");

    const customerName = escapeHtml(doc.customer?.name || "Customer");
    const customerPhone = escapeHtml(doc.customer?.phone || "—");
    const plan = doc.plan || {};
    const planType = plan.planType || "Weekly";
    const templateLabel = escapeHtml(plan.templateLabel || planType);
    const startDate = fmtDate(plan.startDate);
    const durationDays = Number(plan.durationDays || (planType === "Weekly" ? 14 : 30));

    const weeklyTable = () => {
      const mealsOrder = ["Breakfast", "Lunch", "Snacks", "Dinner"];
      const days = Array.from({ length: 14 }, (_, i) => i + 1);
      let thead = `
        <thead>
          <tr>
            <th style="position:sticky;left:0;background:#f5f5f5;z-index:2;">Meal</th>
            ${days.map((d) => `<th>Day ${d}</th>`).join("")}
          </tr>
        </thead>
      `;
      const tbody = `
        <tbody>
          ${mealsOrder
            .map((meal) => {
              const row = (plan.fortnight?.[meal] || Array(14).fill("")).map((v) => `<td>${escapeHtml(v || "—")}</td>`).join("");
              return `
                <tr>
                  <td style="position:sticky;left:0;background:#fff;z-index:1;font-weight:600;">${meal}</td>
                  ${row}
                </tr>
              `;
            })
            .join("")}
        </tbody>
      `;
      return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
    };

    const monthlyList = () => {
      const slots = ["Breakfast", "Lunch", "Evening Snack", "Dinner"];
      return `
        <div class="monthly">
          ${slots
            .map((slot) => {
              const s = plan.monthly?.[slot];
              if (!s) return "";
              const time = escapeHtml(s.time || "");
              const opts = (s.options || []).map((o) => `<li>${escapeHtml(o)}</li>`).join("");
              return `
                <div class="slot">
                  <h3>${slot}${time ? ` <span class="time">(${time})</span>` : ""}</h3>
                  ${opts ? `<ul>${opts}</ul>` : `<p>—</p>`}
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    };

    const bodyHtml = planType === "Weekly" ? weeklyTable() : monthlyList();

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Diet Plan • ${customerName}</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="icon" href="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam_-_Favicon.png?v=1708245689" />
  <style>
    body { margin:0; font-family: system-ui, -apple-system, "Poppins", Segoe UI, Roboto, Arial, sans-serif; color:#111; }
    header { padding:12px 16px; border-bottom:1px solid #eee; display:flex; align-items:center; gap:12px; }
    header img { height:28px; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
    .meta { display:flex; flex-wrap:wrap; gap:12px; align-items:center; color:#444; font-size:14px; }
    .card { background:#fff; border:1px solid #eee; border-radius:12px; padding:16px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    h1 { font-size:22px; margin:8px 0 4px; }
    h2 { font-size:18px; margin:0 0 10px; color:#543087; }
    h3 { font-size:16px; margin:12px 0 6px; }
    .time { color:#666; font-weight:500; }
    .table-wrap { overflow:auto; }
    table { border-collapse: collapse; width: 100%; min-width: 900px; }
    th, td { border:1px solid #eee; padding:8px 10px; vertical-align:top; font-size:14px; }
    th { background:#f5f5f5; text-align:left; }
    ul { margin:6px 0 0 18px; }
    footer { padding:24px 16px 48px; text-align:center; color:#777; font-size:12px; }
    .badge { background:#000; color:#fff; padding:4px 10px; border-radius:999px; font-size:12px; }
  </style>
</head>
<body>
  <header>
    <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam_Logo-01-01.png?v=1725434339" alt="Muditam" />
    <span class="badge">${escapeHtml(planType)}</span>
  </header>

  <div class="wrap">
    <div class="card">
      <h1>Diet Plan for ${customerName}</h1>
      <div class="meta">
        <div><b>Phone:</b> ${customerPhone}</div>
        <div>•</div>
        <div><b>Template:</b> ${templateLabel}</div>
        <div>•</div>
        <div><b>Start:</b> ${startDate}</div>
        <div>•</div>
        <div><b>Duration:</b> ${durationDays} days</div>
      </div>

      <h2 style="margin-top:16px;">Plan Details</h2>
      ${bodyHtml}
    </div>
  </div>

  <footer>
    © ${new Date().getFullYear()} Muditam Ayurveda Pvt. Ltd. • Proven by Science. Rooted in Ayurveda.
  </footer>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("Error in diet plan proxy route:", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
