// routes/orderConfirmations.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const Razorpay = require("razorpay");
const cron = require("node-cron");

const ShopifyOrder = require("../models/ShopifyOrder");
const Order = require("../models/Order");
const Employee = require("../models/Employee");

// Keep these in sync with the schema enum
const CallStatusEnum = {
  CNP: "CNP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  CALL_BACK_LATER: "CALL_BACK_LATER",
  CANCEL_ORDER: "CANCEL_ORDER",
};

const CHANNEL_MAP = {
  "Online Order": "252664381441",
  Team: "205650526209",
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
const stripHash = (n) =>
  String(n || "").startsWith("#") ? String(n).slice(1) : String(n || "");

const getRoleFromReq = (req) =>
  (req.user?.role || req.query.role || "").toString();
const getUserIdFromReq = (req) =>
  (req.user?._id || req.user?.id || req.query.userId || "").toString();

async function assignRoundRobin({ batchSize = 5000 } = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const agents = await Employee.find(
      {
        orderConfirmActive: true,
        $or: [{ status: "active" }, { status: "Active" }],
        role: { $regex: /^operations$/i },
      },
      { _id: 1, fullName: 1 }
    )
      .session(session)
      .sort({ fullName: 1 })
      .lean();

    if (!agents.length) {
      await session.abortTransaction();
      session.endSession();
      return {
        ok: false,
        error: "No eligible agents found (need Operations + Active for OC)",
        assigned: 0,
        agents: 0,
        details: [],
      };
    }

    const CallStatusEnumLocal = {
      CNP: "CNP",
      ORDER_CONFIRMED: "ORDER_CONFIRMED",
      CALL_BACK_LATER: "CALL_BACK_LATER",
      CANCEL_ORDER: "CANCEL_ORDER",
    };

    const baseMatch = {
      $and: [
        { financial_status: /^pending$/i },
        {
          $or: [
            { fulfillment_status: { $exists: false } },
            { fulfillment_status: { $not: /^fulfilled$/i } },
          ],
        },
        {
          $or: [
            { "orderConfirmOps.callStatus": { $exists: false } },
            {
              "orderConfirmOps.callStatus": {
                $ne: CallStatusEnumLocal.ORDER_CONFIRMED,
              },
            },
          ],
        },
        {
          $or: [
            { "orderConfirmOps.assignedAgentId": { $exists: false } },
            { "orderConfirmOps.assignedAgentId": null },
          ],
        },
      ],
    };

    const BATCH_SIZE = Math.max(
      1000,
      Math.min(20000, Number(batchSize) || 5000)
    );
    let totalAssigned = 0;
    const details = agents.map((a) => ({
      agentId: String(a._id),
      name: a.fullName || "",
      count: 0,
    }));

    const now = new Date();

    const cursor = ShopifyOrder.find(baseMatch, { _id: 1 }, { session })
      .sort({ orderDate: -1, createdAt: -1 })
      .cursor();

    let buffer = [];
    let i = 0;

    for await (const doc of cursor) {
      buffer.push(doc._id);
      if (buffer.length >= BATCH_SIZE) {
        const bulk = [];
        for (const id of buffer) {
          const agent = agents[i % agents.length];
          bulk.push({
            updateOne: {
              filter: { _id: id },
              update: {
                $set: {
                  "orderConfirmOps.assignedAgentId": agent._id,
                  "orderConfirmOps.assignedAgentName": agent.fullName || "",
                  "orderConfirmOps.assignedAt": now,
                },
              },
            },
          });
          details[i % agents.length].count += 1;
          totalAssigned += 1;
          i++;
        }
        if (bulk.length) await ShopifyOrder.bulkWrite(bulk, { session });
        buffer = [];
      }
    }

    if (buffer.length) {
      const bulk = [];
      for (const id of buffer) {
        const agent = agents[i % agents.length];
        bulk.push({
          updateOne: {
            filter: { _id: id },
            update: {
              $set: {
                "orderConfirmOps.assignedAgentId": agent._id,
                "orderConfirmOps.assignedAgentName": agent.fullName || "",
                "orderConfirmOps.assignedAt": now,
              },
            },
          },
        });
        details[i % agents.length].count += 1;
        totalAssigned += 1;
        i++;
      }
      if (bulk.length) await ShopifyOrder.bulkWrite(bulk, { session });
    }

    await session.commitTransaction();
    session.endSession();
    return { ok: true, assigned: totalAssigned, agents: agents.length, details };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

router.get("/agents/active", async (_req, res) => {
  try {
    const agents = await Employee.find(
      {
        orderConfirmActive: true,
        $or: [{ status: "active" }, { status: "Active" }],
      },
      { _id: 1, fullName: 1, email: 1, role: 1 }
    )
      .sort({ fullName: 1 })
      .lean();

    res.json({ agents });
  } catch (err) {
    console.error("GET /agents/active error:", err);
    res.status(500).json({ error: "Failed to fetch active agents" });
  }
});

router.post("/agents/toggle", async (req, res) => {
  try {
    const { agentId, active } = req.body || {};
    if (!isValidObjectId(agentId)) {
      return res.status(400).json({ error: "Invalid agentId" });
    }
    const updated = await Employee.findByIdAndUpdate(
      agentId,
      { $set: { orderConfirmActive: !!active } },
      { new: true, projection: { _id: 1, fullName: 1, orderConfirmActive: 1 } }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Agent not found" });
    res.json({ ok: true, agent: updated });
  } catch (err) {
    console.error("POST /agents/toggle error:", err);
    res.status(500).json({ error: "Failed to toggle agent activity" });
  }
});

router.get("/agents/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid agent id" });
    }
    const emp = await Employee.findById(id, {
      _id: 1,
      fullName: 1,
      status: 1,
      role: 1,
      orderConfirmActive: 1,
    }).lean();
    if (!emp) return res.status(404).json({ error: "Agent not found" });
    res.json({ ok: true, agent: emp });
  } catch (err) {
    console.error("GET /agents/:id/status error:", err);
    res.status(500).json({ error: "Failed to fetch agent status" });
  }
});

router.post("/assign/round-robin", async (req, res) => {
  try {
    const result = await assignRoundRobin({ batchSize: req.body?.batchSize });
    if (!result.ok) {
      return res
        .status(400)
        .json({ error: result.error || "Round-robin assignment failed" });
    }
    return res.json(result);
  } catch (err) {
    console.error("POST /assign/round-robin error:", err);
    res
      .status(500)
      .json({ error: "Round-robin assignment failed" });
  }
});

/* ============================================
   LIST (with All CNPs support)
   ============================================ */
router.get("/list", async (req, res) => {
  try {
    const {
      tab,
      section = "pending",
      page = 1,
      limit = 20,
      q = "",
      channel = "",
      assigned = "",
      startDate = "",
      allCnpDate = "", // NEW
    } = req.query;

    const role = getRoleFromReq(req);
    const authedUserId = getUserIdFromReq(req);

    const numericPage = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const clauses = [];

    const rawTab = typeof tab === "string" ? tab.trim() : "";
    const tabUpper = rawTab.toUpperCase().replace(/\s+/g, "_");

    // --- TAB / CALL STATUS LOGIC ---
    if (rawTab) {
      if (Object.values(CallStatusEnum).includes(tabUpper)) {
        // exact enum tab (CNP, ORDER_CONFIRMED, etc.)
        clauses.push({ "orderConfirmOps.callStatus": tabUpper });
      } else if (tabUpper === "PENDING") {
        // Pending = no shopifyNotes
        clauses.push({
          $or: [
            { "orderConfirmOps.shopifyNotes": { $exists: false } },
            { "orderConfirmOps.shopifyNotes": "" },
          ],
        });
      } else if (tabUpper === "ALL_CNPS") {
        // All CNPs -> CNP status
        clauses.push({ "orderConfirmOps.callStatus": CallStatusEnum.CNP });
      } else if (tabUpper !== "ALL") {
        // fallback for unknown tab => treat as CNP
        clauses.push({ "orderConfirmOps.callStatus": CallStatusEnum.CNP });
      }
    } else {
      // Old section logic when no tab passed
      if (section === "confirmed") {
        clauses.push({
          "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED,
        });
      } else {
        clauses.push({
          $or: [
            { "orderConfirmOps.callStatus": { $exists: false } },
            {
              "orderConfirmOps.callStatus": {
                $ne: CallStatusEnum.ORDER_CONFIRMED,
              },
            },
          ],
        });
      }
    }

    // Always pending & not fulfilled
    clauses.push({ financial_status: /^pending$/i });
    clauses.push({
      $or: [
        { fulfillment_status: { $exists: false } },
        { fulfillment_status: { $not: /^fulfilled$/i } },
      ],
    });

    // SEARCH
    if (q) {
      const numericQ = q.replace(/\D/g, "");
      clauses.push({
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
      });
    }

    // CHANNEL
    if (channel && CHANNEL_MAP[channel]) {
      const id = CHANNEL_MAP[channel];
      const idNum = Number(id);
      clauses.push({
        $or: [
          { channelName: { $in: [id, idNum] } },
          { sourceId: { $in: [id, idNum] } },
          { source_id: { $in: [id, idNum] } },
          { channelName: { $regex: `^${channel}$`, $options: "i" } },
        ],
      });
    }

    // ASSIGNED FILTER
    // For All CNPs, IGNORE assigned filter (show all agents)
    if (tabUpper !== "ALL_CNPS") {
      if (assigned === "unassigned") {
        clauses.push({
          $or: [
            { "orderConfirmOps.assignedAgentId": { $exists: false } },
            { "orderConfirmOps.assignedAgentId": null },
          ],
        });
      } else if (assigned && isValidObjectId(assigned)) {
        clauses.push({
          "orderConfirmOps.assignedAgentId": new mongoose.Types.ObjectId(
            String(assigned)
          ),
        });
      } else {
        if (/^operations$/i.test(role) && isValidObjectId(authedUserId)) {
          clauses.push({
            "orderConfirmOps.assignedAgentId":
              new mongoose.Types.ObjectId(String(authedUserId)),
          });
        }
      }
    }

    // DATE LOGIC
    if (tabUpper === "ALL_CNPS") {
      // SPECIAL for All CNPs
      const baseNov = new Date("2025-11-01T00:00:00.000Z"); // after 1 Nov

      if (allCnpDate) {
        // single-day filter
        let dayStart = new Date(`${allCnpDate}T00:00:00.000Z`);
        if (isNaN(dayStart.getTime())) {
          dayStart = baseNov;
        }
        if (dayStart < baseNov) {
          dayStart = baseNov;
        }
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        clauses.push({
          $or: [
            { orderDate: { $gte: dayStart, $lt: dayEnd } },
            { createdAt: { $gte: dayStart, $lt: dayEnd } },
          ],
        });
      } else {
        // Default: everything >= 1 Nov
        clauses.push({
          $or: [
            { orderDate: { $gte: baseNov } },
            { createdAt: { $gte: baseNov } },
          ],
        });
      }
    } else if (startDate) {
      const sd = new Date(startDate);
      if (!isNaN(sd.getTime())) {
        clauses.push({
          $or: [
            { orderDate: { $gte: sd } },
            { createdAt: { $gte: sd } },
          ],
        });
      }
    }

    const filter = clauses.length ? { $and: clauses } : {};

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
      "orderConfirmOps.assignedAgentId": 1,
      "orderConfirmOps.assignedAgentName": 1,
      "orderConfirmOps.assignedAt": 1,
    };

    const [rawItems, total] = await Promise.all([
      ShopifyOrder.find(filter, projection)
        .sort({ orderDate: -1, createdAt: -1 })
        .skip((numericPage - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      ShopifyOrder.countDocuments(filter),
    ]);

    // shipping enrichment
    const orderIds = rawItems
      .map((it) => stripHash(it.orderName))
      .filter(Boolean);
    let shippingMap = {};
    if (orderIds.length) {
      const orders = await Order.find(
        { order_id: { $in: orderIds } },
        {
          order_id: 1,
          shipment_status: 1,
          tracking_number: 1,
          carrier_title: 1,
        }
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
      return { ...it, shipping };
    });

    // previous orders count
    const phonesOnPage = Array.from(
      new Set(items.map((it) => it.normalizedPhone).filter(Boolean))
    );
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
    for (const it of items) {
      it.totalOrdersForPhone = it.normalizedPhone
        ? phoneCountsMap[it.normalizedPhone] || 0
        : 0;
    }

    res.json({ page: numericPage, limit: pageSize, total, items });
  } catch (err) {
    console.error("GET /order-confirmations/list error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

router.post("/create-payment-link", async (req, res) => {
  try {
    const { amount, currency = "INR", customer = {} } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }
    const amountPaise = Math.round(amt * 100);

    const payload = {
      amount: amountPaise,
      currency,
      customer: {
        name: customer?.name || "Customer",
        email: customer?.email || undefined,
        contact: customer?.contact || undefined,
      },
      notify: {
        sms: !!customer?.contact,
        email: !!customer?.email,
      },
      reminder_enable: true,
    };

    const link = await razorpay.paymentLink.create(payload);
    const shortUrl = link?.short_url || link?.url;
    if (!shortUrl) {
      return res
        .status(502)
        .json({ error: "Failed to create payment link" });
    }
    return res.json({ paymentLink: shortUrl, id: link.id });
  } catch (err) {
    console.error(
      "POST /create-payment-link error:",
      err?.response?.data || err.message
    );
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Payment link creation failed",
      details: err?.response?.data || err.message,
    });
  }
});

/* ============================================
   PATCH update (+ allow manual assignment)
   ============================================ */
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    // Atomic plusCount
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

        if (!updated)
          return res.status(404).json({ error: "Order not found" });
        return res.json({ ok: true, orderConfirmOps: updated.orderConfirmOps });
      } catch (err) {
        console.error(
          "PATCH /order-confirmations/:id incPlusCount error:",
          err
        );
        return res
          .status(500)
          .json({ error: "Failed to increment count" });
      }
    }

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
      allowed["orderConfirmOps.callStatusUpdatedAt"] = new Date();
    }

    if (typeof ops.doctorCallNeeded === "boolean") {
      allowed["orderConfirmOps.doctorCallNeeded"] = !!ops.doctorCallNeeded;
      if (!ops.doctorCallNeeded) {
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
        allowed["orderConfirmOps.paymentLink"] = "";
      }
    }

    if (typeof ops.paymentLink === "string") {
      const order = await ShopifyOrder.findById(id, {
        "orderConfirmOps.codToPrepaid": 1,
      }).lean();
      const cod =
        typeof ops.codToPrepaid === "boolean"
          ? !!ops.codToPrepaid
          : order?.orderConfirmOps?.codToPrepaid;
      if (!cod) {
        return res.status(400).json({
          error: "Enable COD to prepaid before setting a payment link",
        });
      }
      allowed["orderConfirmOps.paymentLink"] =
        ops.paymentLink.trim();
    }

    // Manual assignment/unassignment
    if (isValidObjectId(ops.assignedAgentId) || ops.assignedAgentId === null) {
      const agentId = ops.assignedAgentId
        ? new mongoose.Types.ObjectId(String(ops.assignedAgentId))
        : null;
      let agentName = "";
      if (agentId) {
        const emp = await Employee.findById(agentId, { fullName: 1 }).lean();
        agentName = emp?.fullName || "";
      }
      allowed["orderConfirmOps.assignedAgentId"] = agentId;
      allowed["orderConfirmOps.assignedAgentName"] = agentName;
      allowed["orderConfirmOps.assignedAt"] = agentId ? new Date() : null;
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

/* ============================================
   History by phone (unchanged)
   ============================================ */
router.get("/history-by-phone", async (req, res) => {
  try {
    const raw = String(req.query.phone || "");
    const phone = normalizePhone(raw);
    if (!phone) return res.status(400).json({ error: "phone is required" });

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

/* ============================================
   Shopify notes (unchanged)
   ============================================ */
router.post("/shopify-notes", async (req, res) => {
  try {
    const { orderName, note, userFullName: fromBody } = req.body || {};
    if (!orderName || typeof note !== "string") {
      return res
        .status(400)
        .json({ error: "orderName and note are required" });
    }

    if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({
        error: "Shopify credentials are missing in environment",
      });
    }

    const userFullName =
      (typeof fromBody === "string" && fromBody.trim()) ||
      (req.user && (req.user.fullName || req.user.name)) ||
      "";

    const STATUS_LABELS = {
      CNP: "CNP",
      ORDER_CONFIRMED: "Order Confirmed",
      CALL_BACK_LATER: "Call Back Later",
      CANCEL_ORDER: "Cancel Order",
    };

    const raw = String(note).trim();
    const up = raw.toUpperCase().replace(/\s+/g, "_");
    let label;
    if (STATUS_LABELS[up]) {
      label = STATUS_LABELS[up];
    } else {
      const match = Object.values(STATUS_LABELS).find(
        (l) => l.toLowerCase() === raw.toLowerCase()
      );
      label = match || raw;
    }

    const finalNote = userFullName ? `${label} - ${userFullName}` : label;
    const nameWithHash = ensureHashOrderName(orderName);

    const encName = encodeURIComponent(nameWithHash);
    const theFind = await shopifyApi.get(
      `/orders.json?name=${encName}&status=any&limit=1`
    );
    const shopifyOrder = Array.isArray(theFind.data?.orders)
      ? theFind.data.orders[0]
      : null;
    if (!shopifyOrder?.id) {
      return res.status(404).json({
        error: `Shopify order not found for name ${nameWithHash}`,
      });
    }

    const shopifyId = shopifyOrder.id;
    await shopifyApi.put(`/orders/${shopifyId}.json`, {
      order: { id: shopifyId, note: finalNote },
    });

    const possibleNames = [nameWithHash];
    if (nameWithHash.startsWith("#")) possibleNames.push(nameWithHash.slice(1));

    const mongoUpdate = await ShopifyOrder.findOneAndUpdate(
      {
        $or: [{ orderName: { $in: possibleNames } }, { orderId: shopifyId }],
      },
      { $set: { "orderConfirmOps.shopifyNotes": finalNote } },
      {
        new: true,
        projection: {
          orderName: 1,
          orderId: 1,
          "orderConfirmOps.shopifyNotes": 1,
        },
      }
    ).lean();

    res.json({
      ok: true,
      shopify: { id: shopifyId, name: shopifyOrder?.name || nameWithHash },
      mongo: mongoUpdate || null,
      note: finalNote,
    });
  } catch (err) {
    console.error(
      "POST /shopify-notes error:",
      err?.response?.data || err.message
    );
    const status = err?.response?.status || 500;
    res.status(status).json({
      error: "Failed to update Shopify notes",
      details: err?.response?.data || err.message,
    });
  }
});

router.post("/bulk-call-status", async (req, res) => {
  try {
    const { ids = [], callStatus } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const up = String(callStatus || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (!Object.values(CallStatusEnum).includes(up)) {
      return res.status(400).json({ error: "Invalid callStatus value" });
    }

    const result = await ShopifyOrder.updateMany(
      {
        _id: { $in: ids.map((x) => new mongoose.Types.ObjectId(String(x))) },
      },
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

/* ============================================
   Counts (role-aware + All CNPs global count)
   ============================================ */
router.get("/counts", async (req, res) => {
  try {
    const {
      q = "",
      channel = "",
      assigned = "",
      startDate = "",
      tab = "",
      allCnpDate = "",
    } = req.query;

    const role = getRoleFromReq(req);
    const authedUserId = getUserIdFromReq(req);

    const clauses = [];
    // scope to pending + not-fulfilled (same as /list)
    clauses.push({ financial_status: /^pending$/i });
    clauses.push({
      $or: [
        { fulfillment_status: { $exists: false } },
        { fulfillment_status: { $not: /^fulfilled$/i } },
      ],
    });

    // text / phone search (same as /list)
    if (q) {
      const numericQ = q.replace(/\D/g, "");
      clauses.push({
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
      });
    }

    // channel filter (same as /list)
    if (channel && CHANNEL_MAP[channel]) {
      const id = CHANNEL_MAP[channel];
      const idNum = Number(id);
      clauses.push({
        $or: [
          { channelName: { $in: [id, idNum] } },
          { sourceId: { $in: [id, idNum] } },
          { source_id: { $in: [id, idNum] } },
          { channelName: { $regex: `^${channel}$`, $options: "i" } },
        ],
      });
    }

    // assignment scoping for normal tabs (not All CNPs global)
    if (assigned === "unassigned") {
      clauses.push({
        $or: [
          { "orderConfirmOps.assignedAgentId": { $exists: false } },
          { "orderConfirmOps.assignedAgentId": null },
        ],
      });
    } else if (assigned && isValidObjectId(assigned)) {
      clauses.push({
        "orderConfirmOps.assignedAgentId": new mongoose.Types.ObjectId(
          String(assigned)
        ),
      });
    } else {
      if (/^operations$/i.test(role) && isValidObjectId(authedUserId)) {
        clauses.push({
          "orderConfirmOps.assignedAgentId": new mongoose.Types.ObjectId(
            String(authedUserId)
          ),
        });
      }
    }

    // startDate filter (mirror of /list)
    if (startDate) {
      const sd = new Date(startDate);
      if (!isNaN(sd.getTime())) {
        clauses.push({
          $or: [
            { orderDate: { $gte: sd } },
            { createdAt: { $gte: sd } },
          ],
        });
      }
    }

    const baseMatch = clauses.length ? { $and: clauses } : {};

    // "Pending" = no shopifyNotes (same as /list’s pending logic)
    const pendingNotesMatch = {
      $and: [
        ...(Array.isArray(baseMatch.$and) ? baseMatch.$and : [baseMatch]),
        {
          $or: [
            { "orderConfirmOps.shopifyNotes": { $exists: false } },
            { "orderConfirmOps.shopifyNotes": "" },
          ],
        },
      ],
    };

    // All CNPs global count (ignores assignment) with 1 Nov + optional day filter
    const allCnpCountPromise = (async () => {
      const c = [];

      // core pending + not fulfilled
      c.push({ financial_status: /^pending$/i });
      c.push({
        $or: [
          { fulfillment_status: { $exists: false } },
          { fulfillment_status: { $not: /^fulfilled$/i } },
        ],
      });

      // CNP only
      c.push({ "orderConfirmOps.callStatus": CallStatusEnum.CNP });

      // search
      if (q) {
        const numericQ = q.replace(/\D/g, "");
        c.push({
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
        });
      }

      // channel
      if (channel && CHANNEL_MAP[channel]) {
        const id = CHANNEL_MAP[channel];
        const idNum = Number(id);
        c.push({
          $or: [
            { channelName: { $in: [id, idNum] } },
            { sourceId: { $in: [id, idNum] } },
            { source_id: { $in: [id, idNum] } },
            { channelName: { $regex: `^${channel}$`, $options: "i" } },
          ],
        });
      }

      // date: after 1 Nov by default, or single-day filter if allCnpDate provided
      const baseNov = new Date("2025-11-01T00:00:00.000Z");

      if (allCnpDate) {
        let dayStart = new Date(`${allCnpDate}T00:00:00.000Z`);
        if (isNaN(dayStart.getTime())) {
          dayStart = baseNov;
        }
        if (dayStart < baseNov) {
          dayStart = baseNov;
        }
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

        c.push({
          $or: [
            { orderDate: { $gte: dayStart, $lt: dayEnd } },
            { createdAt: { $gte: dayStart, $lt: dayEnd } },
          ],
        });
      } else {
        c.push({
          $or: [
            { orderDate: { $gte: baseNov } },
            { createdAt: { $gte: baseNov } },
          ],
        });
      }

      const match = c.length ? { $and: c } : {};
      return ShopifyOrder.countDocuments(match);
    })();

    const [allCount, grouped, pendingNotesCount, allCnpCount] =
      await Promise.all([
        ShopifyOrder.countDocuments(baseMatch),
        ShopifyOrder.aggregate([
          { $match: baseMatch },
          { $group: { _id: "$orderConfirmOps.callStatus", c: { $sum: 1 } } },
        ]),
        ShopifyOrder.countDocuments(pendingNotesMatch),
        allCnpCountPromise,
      ]);

    const by = grouped.reduce((acc, r) => {
      const key = String(r._id || "").toUpperCase();
      acc[key] = r.c;
      return acc;
    }, {});

    res.json({
      counts: {
        ALL: allCount,
        PENDING: pendingNotesCount,
        CNP: by.CNP || 0,
        ORDER_CONFIRMED: by.ORDER_CONFIRMED || 0,
        CALL_BACK_LATER: by.CALL_BACK_LATER || 0,
        CANCEL_ORDER: by.CANCEL_ORDER || 0,
        ALL_CNPS: allCnpCount || 0,
      },
    });
  } catch (err) {
    console.error("GET /order-confirmations/counts error:", err);
    res.status(500).json({ error: "Failed to fetch counts" });
  }
});

router.get("/today-confirmed-count", async (req, res) => {
  try {
    const maybeAgentId = String(req.query.agentId || "");
    const userId = getUserIdFromReq(req);

    // Determine agent filter
    const agentId = isValidObjectId(maybeAgentId)
      ? new mongoose.Types.ObjectId(maybeAgentId)
      : isValidObjectId(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;

    // Build IST "today" boundaries -> as UTC instants
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);

    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - istOffsetMs;
    const endUtcMs =
      Date.UTC(y, m - 1, d, 23, 59, 59, 999) - istOffsetMs;

    const start = new Date(startUtcMs);
    const end = new Date(endUtcMs);

    const clauses = [
      { financial_status: /^pending$/i },
      {
        $or: [
          { fulfillment_status: { $exists: false } },
          { fulfillment_status: { $not: /^fulfilled$/i } },
        ],
      },
      { "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED },
      { "orderConfirmOps.callStatusUpdatedAt": { $gte: start, $lte: end } },
    ];

    if (agentId) {
      clauses.push({ "orderConfirmOps.assignedAgentId": agentId });
    }

    const count = await ShopifyOrder.countDocuments({ $and: clauses });
    res.json({ count });
  } catch (err) {
    console.error("GET /today-confirmed-count error:", err);
    res.status(500).json({ error: "Failed to compute today's confirmed count" });
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const {
      orderName,
      orderId,
      reason = "customer",
      email = true,
      restock = true,
      note = "Cancelled via Order Confirmations UI",
      ocCancelReason = "", // local-only reason from UI
    } = req.body || {};

    if (!orderName && !orderId) {
      return res
        .status(400)
        .json({ error: "Provide orderName or orderId" });
    }

    if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({
        error: "Shopify credentials are missing in environment",
      });
    }

    let shopifyId = null;
    let shopifyName = null;

    if (orderId) {
      shopifyId = String(orderId).replace(/\D/g, "");
      const { data } = await shopifyApi.get(`/orders/${shopifyId}.json`);
      if (!data?.order?.id) {
        return res.status(404).json({
          error: `Shopify order not found for id ${orderId}`,
        });
      }
      shopifyName = data.order.name;
      if (String(data.order.cancelled_at || "")) {
        return res.json({
          ok: true,
          alreadyCancelled: true,
          shopify: { id: shopifyId, name: shopifyName },
        });
      }
    } else {
      const nameWithHash = ensureHashOrderName(orderName);
      const encName = encodeURIComponent(nameWithHash);
      const findResp = await shopifyApi.get(
        `/orders.json?name=${encName}&status=any&limit=1`
      );
      const order = Array.isArray(findResp.data?.orders)
        ? findResp.data.orders[0]
        : null;
      if (!order?.id) {
        return res.status(404).json({
          error: `Shopify order not found for name ${nameWithHash}`,
        });
      }
      // if already cancelled, short-circuit
      if (String(order.cancelled_at || "")) {
        return res.json({
          ok: true,
          alreadyCancelled: true,
          shopify: { id: order.id, name: order.name },
        });
      }
      shopifyId = order.id;
      shopifyName = order.name;
    }

    // 2) Cancel on Shopify
    const cancelResp = await shopifyApi.post(
      `/orders/${shopifyId}/cancel.json`,
      {
        reason,
        email,
        restock,
        note,
      }
    );

    const cancelled = cancelResp?.data?.order;
    if (!cancelled?.id || !cancelled?.cancelled_at) {
      return res.status(500).json({
        error: "Shopify cancel failed (unexpected response)",
      });
    }

    // 3) Mirror note to Mongo (and set callStatus)
    const possibleNames = [
      shopifyName || "",
      stripHash(shopifyName || ""),
      ensureHashOrderName(shopifyName || ""),
    ].filter(Boolean);

    await ShopifyOrder.findOneAndUpdate(
      {
        $or: [{ orderId: shopifyId }, { orderName: { $in: possibleNames } }],
      },
      {
        $set: {
          "orderConfirmOps.shopifyNotes": note,
          "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER,
          "orderConfirmOps.callStatusUpdatedAt": new Date(),
          "orderConfirmOps.ocCancelReason": ocCancelReason,
        },
      },
      { new: true }
    ).lean();

    try {
      await shopifyApi.put(`/orders/${shopifyId}.json`, {
        order: { id: shopifyId, note },
      });
    } catch (_) {
      // ignore note failure
    }

    return res.json({
      ok: true,
      shopify: { id: shopifyId, name: shopifyName },
      note,
    });
  } catch (err) {
    const code = err?.response?.status || 500;
    const details = err?.response?.data || err.message;
    console.error("POST /order-confirmations/cancel error:", details);
    return res
      .status(code)
      .json({ error: "Cancel operation failed", details });
  }
});

let __ocBusy = false;

cron.schedule("*/59 * * * *", async () => {
  if (__ocBusy) return;
  __ocBusy = true;
  const started = Date.now();
  try {
    // 1) Round-robin assignment
    const rr = await assignRoundRobin({});
    console.log(
      `[OC CRON] round-robin assigned=${rr.assigned || 0} (agents=${
        rr.agents || 0
      })`
    );

    await axios.get(
      "https://muditamleads-14f32a10d7f7.herokuapp.com/api/orders-shopify/sync-new",
      {
        timeout: 120000,
      }
    );

    console.log(`[OC CRON] done in ${(Date.now() - started) / 1000}s`);
  } catch (e) {
    console.error(
      "[OC CRON] error:",
      e?.response?.data || e.message || e
    );
  } finally {
    __ocBusy = false;
  }
});

module.exports = router;
