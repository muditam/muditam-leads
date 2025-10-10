// routes/orders.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Order = require("../models/Order");     // adjust path as needed
const Lead = require("../models/Lead");       // adjust path as needed
const Customer = require("../models/Customer"); // adjust path as needed

// Helper: normalize to last 10 digits (strip non-digits and country codes)
const normalizeTo10 = (str = "") => {
  const onlyDigits = String(str).replace(/\D/g, "");
  // Keep last 10 digits (handles +91 / leading 0 / longer inputs)
  return onlyDigits.length > 10
    ? onlyDigits.slice(-10)
    : onlyDigits;
};

/**
 * GET /api/orders/unassigned-delivered-count
 * Returns: { count, sample (optional) }
 */
router.get("/unassigned-delivered-count", async (req, res) => {
  try {
    // 1) Pull delivered orders with a contact number
    const deliveredOrders = await Order.find(
      { shipment_status: "Delivered", contact_number: { $exists: true, $ne: null } },
      { contact_number: 1, _id: 0 }
    ).lean();

    // 2) Gather unique normalized delivered contacts
    const deliveredSet = new Set(
      deliveredOrders
        .map(o => normalizeTo10(o.contact_number))
        .filter(Boolean)
    );

    if (deliveredSet.size === 0) {
      return res.json({ count: 0 });
    }

    // 3) Pull Lead.contactNumber and Customer.phone, normalize, and put in sets
    const leadContacts = await Lead.find(
      { contactNumber: { $exists: true, $ne: null } },
      { contactNumber: 1, _id: 0 }
    ).lean();

    const customerPhones = await Customer.find(
      { phone: { $exists: true, $ne: null } },
      { phone: 1, _id: 0 }
    ).lean();

    const leadSet = new Set(
      leadContacts.map(l => normalizeTo10(l.contactNumber)).filter(Boolean)
    );
    const customerSet = new Set(
      customerPhones.map(c => normalizeTo10(c.phone)).filter(Boolean)
    );

    // 4) Count those delivered numbers not present in leads or customers
    let unassignedCount = 0;
    for (const num of deliveredSet) {
      if (!leadSet.has(num) && !customerSet.has(num)) {
        unassignedCount += 1;
      }
    }

    // Optional: include a tiny sample for spot-checking in logs/UI if you want
    // const sample = Array.from(deliveredSet).filter(n => !leadSet.has(n) && !customerSet.has(n)).slice(0, 5);

    res.json({ count: unassignedCount /*, sample*/ });
  } catch (err) {
    console.error("Error computing unassigned delivered count:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
