const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const ShopifyOrder = require("../models/ShopifyOrder");
const cron = require("node-cron");

function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

// ===============================
// MAIN FUNCTION USED BY API + CRON
// ===============================
async function reactivateRecentLostCustomers() {
  // 60 days logic
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  // Step 1 — Fetch customers who ordered in last 60 days
  const recentOrders = await ShopifyOrder.find({
    orderDate: { $gte: sixtyDaysAgo }
  }).select("contactNumber normalizedPhone");

  if (!recentOrders.length) {
    return { updated: 0, message: "No recent buyers found" };
  }

  const phones = recentOrders
    .map(o => normalizePhone(o.normalizedPhone || o.contactNumber))
    .filter(Boolean);

  // Step 2 — Find LOST leads for these customers
  const lostLeads = await Lead.find({
    contactNumber: { $in: phones },
    retentionStatus: "Lost"
  });

  if (!lostLeads.length) {
    return { updated: 0, message: "No lost leads to update" };
  }

  // Step 3 — Update them
  const updateResult = await Lead.updateMany(
    {
      contactNumber: { $in: phones },
      retentionStatus: "Lost"
    },
    {
      $set: {
        retentionStatus: "Active",
        healthExpertAssigned: "",
        retentionStatusUpdatedAt: new Date()
      }
    }
  );

  return {
    updated: updateResult.modifiedCount,
    message: "Retention leads auto-reactivated"
  };
}

// ===============================
// API ENDPOINT (Manual Trigger)
// ===============================
router.post("/reactivate-recent-buyers", async (req, res) => {
  try {
    const result = await reactivateRecentLostCustomers();
    res.json(result);
  } catch (err) {
    console.error("Auto-reactivate error:", err);
    res.status(500).json({ error: err.message });
  }
});

cron.schedule("0 22 * * *", async () => {
  console.log("CRON: Running Retention Auto Reactivation (10PM)");
  try {
    const result = await reactivateRecentLostCustomers();
    console.log("CRON RESULT:", result);
  } catch (err) {
    console.error("CRON ERROR:", err);
  }
});

module.exports = router;
