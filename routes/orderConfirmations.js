// routes/orderConfirmations.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const Razorpay = require("razorpay");

const ShopifyOrder = require("../models/ShopifyOrder");
const Order = require("../models/Order");

// Keep these in sync with the schema enum
const CallStatusEnum = {
  CNP: "CNP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  CALL_BACK_LATER: "CALL_BACK_LATER",
  CANCEL_ORDER: "CANCEL_ORDER",
};

// --- Shopify Admin API client ---
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME; // e.g. "muditam"
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopifyApi = axios.create({
  baseURL: `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-10`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    "Content-Type": "application/json",
  },
});

// --- Razorpay client ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// Utilities
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}
function ensureHashOrderName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.startsWith("#") ? n : `#${n}`;
}
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));
const stripHash = (n) => (String(n || "").startsWith("#") ? String(n).slice(1) : String(n || ""));

/**
 * ------------------------------
 *   Create Razorpay Payment Link
 * ------------------------------
 * POST /api/order-confirmations/create-payment-link
 * Body: { amount, currency?, customer: { name?, email?, contact } }
 * - amount in rupees (number); server converts to paise
 * - currency default "INR"
 * - contact will be normalized to 10 digits and sent as +91XXXXXXXXXX
 * Returns: { paymentLink, id }
 */
router.post("/create-payment-link", async (req, res) => {
  try {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ message: "Razorpay credentials missing in environment" });
    }

    const { amount, currency = "INR", customer = {} } = req.body || {};
    const rupees = Number(amount);

    if (!rupees || rupees <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const ten = normalizePhone(customer.contact);
    if (!ten || ten.length !== 10) {
      return res.status(400).json({ message: "Customer phone must be 10 digits" });
    }

    const options = {
      amount: Math.round(rupees * 100), // rupees -> paise
      currency,
      accept_partial: false,
      description: "Payment for order",
      customer: {
        name: customer.name || "Customer",
        email: customer.email || "",
        contact: `+91${ten}`,
      },
      notify: {
        sms: true,
        email: Boolean(customer.email),
      },
      // reference_id: `ORD-${Date.now()}`, // optional
      // reminder_enable: true, // optional
    };

    const link = await razorpay.paymentLink.create(options);
    return res.json({ paymentLink: link.short_url, id: link.id });
  } catch (error) {
    console.error("Error generating payment link:", error?.response?.data || error.message);
    return res
      .status(500)
      .json({ message: "Error generating payment link", error: error?.response?.data || error.message });
  }
});

router.get("/list", async (req, res) => {
  try {
    const {
      tab,
      section = "pending",
      page = 1,
      limit = 20,
      q = "",
    } = req.query;

    const numericPage = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    // --- Build filter ---
    let baseFilter = {};

    if (typeof tab === "string" && tab.trim()) {
      const up = tab.trim().toUpperCase().replace(/\s+/g, "_");

      if (up === "ALL") {
        // No call-status filter for ALL
        baseFilter = {};
      } else if (Object.values(CallStatusEnum).includes(up)) {
        // Strictly by enum
        baseFilter = { "orderConfirmOps.callStatus": up };
      } else {
        // Unknown tab → default sensibly to CNP
        baseFilter = { "orderConfirmOps.callStatus": CallStatusEnum.CNP };
      }
    } else {
      // Legacy behavior: section=pending|confirmed
      const sectionFilter =
        section === "confirmed"
          ? { "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED }
          : {
            $or: [
              { "orderConfirmOps.callStatus": { $exists: false } },
              { "orderConfirmOps.callStatus": { $ne: CallStatusEnum.ORDER_CONFIRMED } },
            ],
          };
      baseFilter = { ...sectionFilter };
    }

    // Always restrict to financial_status: pending (case-insensitive)
    const financialFilter = { financial_status: /^pending$/i };

    const fulfillmentFilter = {
      $or: [
        { fulfillment_status: { $exists: false } },
        { fulfillment_status: { $not: /^fulfilled$/i } },
      ],
    };

    // Lightweight keyword search
    const numericQ = q ? q.replace(/\D/g, "") : "";
    const textFilter = q
      ? {
        $or: [
          { orderName: { $regex: q, $options: "i" } },
          { customerName: { $regex: q, $options: "i" } },
          ...(numericQ
            ? [
              { contactNumber: { $regex: numericQ } },
              { normalizedPhone: { $regex: numericQ } },
            ]
            : []),
        ],
      }
      : {};

    const filter = { ...baseFilter, ...financialFilter, ...fulfillmentFilter, ...textFilter };

    const projection = {
      orderDate: 1,
      orderId: 1,
      orderName: 1,
      customerName: 1,
      contactNumber: 1,
      normalizedPhone: 1,
      "customerAddress.address1": 1,
      "customerAddress.address2": 1,
      "customerAddress.city": 1,
      "customerAddress.province": 1,
      "customerAddress.zip": 1,
      "customerAddress.country": 1,
      productsOrdered: 1,
      amount: 1,
      modeOfPayment: 1,
      paymentGatewayNames: 1,
      financial_status: 1,
      fulfillment_status: 1,
      currency: 1,
      channelName: 1,

      // ops fields
      "orderConfirmOps.callStatus": 1,
      "orderConfirmOps.callStatusUpdatedAt": 1,
      "orderConfirmOps.shopifyNotes": 1,
      "orderConfirmOps.doctorCallNeeded": 1,
      "orderConfirmOps.dietPlanNeeded": 1,
      "orderConfirmOps.assignedExpert": 1,
      "orderConfirmOps.languageUsed": 1,
      "orderConfirmOps.codToPrepaid": 1,
      "orderConfirmOps.paymentLink": 1,
      "orderConfirmOps.plusCount": 1,    
      "orderConfirmOps.plusUpdatedAt": 1,   
    };  

    const [rawItems, total] = await Promise.all([
      ShopifyOrder.find(filter, projection)
        .sort({ orderDate: -1, createdAt: -1 })
        .skip((numericPage - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      ShopifyOrder.countDocuments(filter),
    ]);

    // ---- Enrich with shipping info from Order (order_id = orderName without '#') ----
    const orderIds = rawItems.map((it) => stripHash(it.orderName)).filter(Boolean);

    let shippingMap = {};
    if (orderIds.length) {
      const orders = await Order.find(
        { order_id: { $in: orderIds } },
        { order_id: 1, shipment_status: 1, tracking_number: 1, carrier_title: 1 }
      ).lean();

      shippingMap = orders.reduce((acc, o) => {
        acc[String(o.order_id)] = {
          shipment_status: o.shipment_status || null,
          tracking_number: o.tracking_number || null,
          carrier_title: o.carrier_title || null,
        };
        return acc;
      }, {});
    }

    const items = rawItems.map((it) => {
      const k = stripHash(it.orderName);
      const shipping = shippingMap[k] || null;
      return { ...it, shipping }; // attach under "shipping" to avoid top-level collisions
    });

    const phonesOnPage = Array.from(new Set(items.map((it) => it.normalizedPhone).filter(Boolean)));
    let phoneCountsMap = {};
    if (phonesOnPage.length) {
      const phoneCounts = await ShopifyOrder.aggregate([
        { $match: { normalizedPhone: { $in: phonesOnPage } } },
        { $group: { _id: "$normalizedPhone", total: { $sum: 1 } } },
      ]);
      phoneCountsMap = phoneCounts.reduce((acc, row) => {
        acc[row._id] = row.total;
        return acc;
      }, {});
    }
    // attach per-item
    for (const it of items) {
      if (it.normalizedPhone) {
        it.totalOrdersForPhone = phoneCountsMap[it.normalizedPhone] || 0;
      } else {
        it.totalOrdersForPhone = 0;
      }
    }

    res.json({
      page: numericPage,
      limit: pageSize,
      total,
      items,
    });
  } catch (err) {
    console.error("GET /order-confirmations/list error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// PATCH /api/order-confirmations/:id
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Defensive: avoid CastError 500s
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    // ---- Atomic increment branch for plusCount ----
    if (req.body && req.body.incPlusCount === true) {
      try { 
        const updated = await ShopifyOrder.findByIdAndUpdate(
          id,
          {
            $inc: { "orderConfirmOps.plusCount": 1 },
            $set: { "orderConfirmOps.plusUpdatedAt": new Date() }, 
          },
          { new: true, projection: { orderConfirmOps: 1 } }
        ).lean();

        if (!updated) return res.status(404).json({ error: "Order not found" });
        return res.json({ ok: true, orderConfirmOps: updated.orderConfirmOps });
      } catch (err) {
        console.error("PATCH /order-confirmations/:id incPlusCount error:", err);
        return res.status(500).json({ error: "Failed to increment count" });
      }
    }

    // ---- Regular allowed field updates ----
    const allowed = {};
    const ops = req.body || {};

    if (typeof ops.shopifyNotes === "string") {
      allowed["orderConfirmOps.shopifyNotes"] = ops.shopifyNotes;
    }

    if (typeof ops.callStatus === "string") {
      const up = ops.callStatus.trim().toUpperCase().replace(/\s+/g, "_");
      if (!Object.values(CallStatusEnum).includes(up)) {
        return res.status(400).json({ error: "Invalid callStatus value" });
      }
      allowed["orderConfirmOps.callStatus"] = up;
      allowed["orderConfirmOps.callStatusUpdatedAt"] = new Date(); // update timestamp whenever dropdown changes
    }

    if (typeof ops.doctorCallNeeded === "boolean") {
      allowed["orderConfirmOps.doctorCallNeeded"] = !!ops.doctorCallNeeded;
      if (!ops.doctorCallNeeded) {
        // clear assignment if doctorCallNeeded is turned off
        allowed["orderConfirmOps.assignedExpert"] = "";
      }
    }

    if (typeof ops.dietPlanNeeded === "boolean") {
      allowed["orderConfirmOps.dietPlanNeeded"] = !!ops.dietPlanNeeded;
    }

    if (typeof ops.assignedExpert === "string") {
      allowed["orderConfirmOps.assignedExpert"] = ops.assignedExpert;
    }

    if (typeof ops.languageUsed === "string") {
      allowed["orderConfirmOps.languageUsed"] = ops.languageUsed.trim();
    }

    if (typeof ops.codToPrepaid === "boolean") {
      allowed["orderConfirmOps.codToPrepaid"] = !!ops.codToPrepaid;
      if (!ops.codToPrepaid) {
        // auto-clear payment link if toggled off
        allowed["orderConfirmOps.paymentLink"] = "";
      }
    }

    if (typeof ops.paymentLink === "string") {
      // Only permit saving a link if codToPrepaid is (or will be) true
      const order = await ShopifyOrder.findById(id, { "orderConfirmOps.codToPrepaid": 1 }).lean();
      const cod = typeof ops.codToPrepaid === "boolean" ? !!ops.codToPrepaid : order?.orderConfirmOps?.codToPrepaid;
      if (!cod) {
        return res.status(400).json({ error: "Enable COD to prepaid before setting a payment link" });
      }
      allowed["orderConfirmOps.paymentLink"] = ops.paymentLink.trim();
    }

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    let updated;
    try {
      updated = await ShopifyOrder.findByIdAndUpdate(
        id,
        { $set: allowed },
        { new: true, projection: { orderConfirmOps: 1 } }
      ).lean();
    } catch (err) {
      if (err?.name === "CastError") {
        return res.status(400).json({ error: "Invalid order id" });
      }
      throw err;
    }

    if (!updated) return res.status(404).json({ error: "Order not found" });
    res.json({ ok: true, orderConfirmOps: updated.orderConfirmOps });
  } catch (err) {
    console.error("PATCH /order-confirmations/:id error:", err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

router.get("/history-by-phone", async (req, res) => {
  try {
    const raw = String(req.query.phone || "");
    const phone = normalizePhone(raw);
    if (!phone) {
      return res.status(400).json({ error: "phone is required" });
    }

    const items = await Order.find(
      { contact_number: phone },
      {
        _id: 0,
        order_id: 1,
        shipment_status: 1,
        order_date: 1,
        tracking_number: 1,
        carrier_title: 1,
      }
    )
      .sort({ order_date: -1, createdAt: -1 })
      .lean();

    res.json({ items: items || [] });
  } catch (err) {
    console.error("GET /history-by-phone error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// POST /api/order-confirmations/shopify-notes
// Body: { orderName: "1001" | "#1001", note: "text to set as Shopify order.note" }
router.post("/shopify-notes", async (req, res) => {
  try {
    const { orderName, note } = req.body || {};
    if (!orderName || typeof note !== "string") {
      return res.status(400).json({ error: "orderName and note are required" });
    }

    if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Shopify credentials are missing in environment" });
    }

    const nameWithHash = ensureHashOrderName(orderName);

    // 1) Find order in Shopify by name (must include '#')
    const encName = encodeURIComponent(nameWithHash);
    theFind = await shopifyApi.get(`/orders.json?name=${encName}&status=any&limit=1`);
    const shopifyOrder = Array.isArray(theFind.data?.orders) ? theFind.data.orders[0] : null;

    if (!shopifyOrder?.id) {
      return res.status(404).json({ error: `Shopify order not found for name ${nameWithHash}` });
    }

    const shopifyId = shopifyOrder.id;

    // 2) Update Shopify order note
    await shopifyApi.put(`/orders/${shopifyId}.json`, {
      order: { id: shopifyId, note },
    });

    // 3) Mirror in Mongo: try by exact orderName with/without '#', otherwise by numeric ID
    const possibleNames = [nameWithHash];
    if (nameWithHash.startsWith("#")) possibleNames.push(nameWithHash.slice(1));

    const mongoUpdate = await ShopifyOrder.findOneAndUpdate(
      { $or: [{ orderName: { $in: possibleNames } }, { orderId: shopifyId }] },
      { $set: { "orderConfirmOps.shopifyNotes": note } },
      { new: true, projection: { orderName: 1, orderId: 1, "orderConfirmOps.shopifyNotes": 1 } }
    ).lean();

    res.json({
      ok: true,
      shopify: { id: shopifyId, name: shopifyOrder?.name || nameWithHash },
      mongo: mongoUpdate || null,
      note,
    });
  } catch (err) {
    console.error("POST /shopify-notes error:", err?.response?.data || err.message);
    const status = err?.response?.status || 500;
    res.status(status).json({ error: "Failed to update Shopify notes", details: err?.response?.data || err.message });
  }
});

// Optional: bulk call status
router.post("/bulk-call-status", async (req, res) => {
  try {
    const { ids = [], callStatus } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const up = String(callStatus || "").trim().toUpperCase().replace(/\s+/g, "_");
    if (!Object.values(CallStatusEnum).includes(up)) {
      return res.status(400).json({ error: "Invalid callStatus value" });
    }

    const result = await ShopifyOrder.updateMany(
      { _id: { $in: ids.map((x) => new mongoose.Types.ObjectId(String(x))) } },
      {
        $set: {
          "orderConfirmOps.callStatus": up,
          "orderConfirmOps.callStatusUpdatedAt": new Date(),
        },
      }
    );

    res.json({
      ok: true,
      matched: result.matchedCount ?? result.n,
      modified: result.modifiedCount ?? result.nModified,
    });
  } catch (err) {
    console.error("POST /bulk-call-status error:", err);
    res.status(500).json({ error: "Bulk update failed" });
  }
});

module.exports = router;
