// routes/orderConfirmations.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const Razorpay = require("razorpay");
const cron = require("node-cron");


// Models
const ShopifyOrder = require("../models/ShopifyOrder");
const Order = require("../models/Order");
const Employee = require("../models/Employee");


// Call statuses (same as schema)
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


/* -----------------------------------------
   Shopify Admin API client
------------------------------------------*/
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;


const shopifyApi = axios.create({
  baseURL: `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-10`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    "Content-Type": "application/json",
  },
});


/* -----------------------------------------
   Razorpay client
------------------------------------------*/
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


/* -----------------------------------------
   Utility Helpers
------------------------------------------*/
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}


function ensureHashOrderName(name) {
  const n = String(name || "").trim();
  return n.startsWith("#") ? n : `#${n}`;
}


const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));


const stripHash = (n) =>
  (String(n || "").startsWith("#") ? String(n).slice(1) : String(n || ""));


const getRoleFromReq = (req) =>
  (req.user?.role || req.query.role || "").toString();


const getUserIdFromReq = (req) =>
  (req.user?._id || req.user?.id || req.query.userId || "").toString();


/* -----------------------------------------
   ROUND ROBIN ASSIGNMENT (unchanged)
------------------------------------------*/
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
          totalAssigned++;
          i++;
        }
        if (bulk.length)
          await ShopifyOrder.bulkWrite(bulk, { session });


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
        totalAssigned++;
        i++;
      }
      if (bulk.length)
        await ShopifyOrder.bulkWrite(bulk, { session });
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
/* ===========================================================
   AGENTS LIST / TOGGLE / STATUS
=========================================================== */
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
      {
        new: true,
        projection: { _id: 1, fullName: 1, orderConfirmActive: 1 },
      }
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




// GET /api/order-confirmations/list
router.get("/list", async (req, res) => {
  try {
    const {
      tab = "",
      q = "",
      channel = "",
      assigned = null,
      page = 1,
      limit = 20,
      startDate = null,
      endDate = null,
    } = req.query;


    const authedUserId = req.user?._id;
    const tabStr = String(tab).toUpperCase();


    const clauses = [];


    /* -----------------------------------------
          TEXT / PHONE SEARCH
    ------------------------------------------ */
    if (q.trim()) {
      const clean = q.replace(/\D/g, "");
      clauses.push({
        $or: [
          { orderName: { $regex: q, $options: "i" } },
          { contactNumber: clean },
          { normalizedPhone: clean },
        ],
      });
    }


    /* -----------------------------------------
                 CHANNEL
    ------------------------------------------ */
    if (channel) clauses.push({ channelName: channel });


    /* -----------------------------------------
                  DATE FILTER
    ------------------------------------------ */
    if (startDate && endDate) {
      clauses.push({
        orderDate: { $gte: new Date(startDate), $lte: new Date(endDate) },
      });
    }


    /* -----------------------------------------
                 TAB FILTERS
    ------------------------------------------ */


    // ALL_CNP → Show all CNP regardless of assigned agent
    if (tabStr === "ALL_CNP") {
      clauses.push({ "orderConfirmOps.callStatus": "CNP" });
    }


    // CNP → ONLY orders marked CNP by THIS USER
    else if (tabStr === "CNP") {
      clauses.push({
        "orderConfirmOps.callStatus": "CNP",
        "orderConfirmOps.callStatusUpdatedBy": authedUserId,
      });
    }


    // PENDING
    else if (tabStr === "PENDING") {
      clauses.push({
        $or: [
          { "orderConfirmOps.shopifyNotes": { $exists: false } },
          { "orderConfirmOps.shopifyNotes": "" },
        ],
      });
    }


    // Other statuses
    else if (
      tabStr !== "ALL" &&
      Object.values(CallStatusEnum).includes(tabStr)
    ) {
      clauses.push({ "orderConfirmOps.callStatus": tabStr });
    }


    /* -----------------------------------------
             ASSIGNED FILTER (SKIP FOR ALL_CNP)
    ------------------------------------------ */
    if (tabStr !== "ALL_CNP") {
      const assignedStr = String(assigned || "").toUpperCase();


      if (assignedStr === "UNASSIGNED") {
        clauses.push({
          $or: [
            { "orderConfirmOps.assignedAgentId": { $exists: false } },
            { "orderConfirmOps.assignedAgentId": null },
          ],
        });
      } else if (assignedStr && assignedStr !== "ALL") {
        if (isValidObjectId(assignedStr)) {
          clauses.push({
            "orderConfirmOps.assignedAgentId": new mongoose.Types.ObjectId(
              assignedStr
            ),
          });
        }
      }
    }


    /* -----------------------------------------
                 FINAL QUERY
    ------------------------------------------ */
    const finalQuery = clauses.length ? { $and: clauses } : {};


    const rows = await ShopifyOrder.find(finalQuery)
      .sort({ orderDate: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();


    const total = await ShopifyOrder.countDocuments(finalQuery);


    res.json({ items: rows, total });
  } catch (err) {
    console.error("LIST FIX ERROR:", err);
    res.status(500).json({ error: "List fetch failed" });
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
      return res.status(502).json({ error: "Failed to create payment link" });
    }


    return res.json({ paymentLink: shortUrl, id: link.id });
  } catch (err) {
    console.error("POST /create-payment-link error:", err?.response?.data || err.message);
    const status = err?.response?.status || 500;


    return res.status(status).json({
      error: "Payment link creation failed",
      details: err?.response?.data || err.message,
    });
  }
});


router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;


    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }




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
        console.error("incPlusCount error:", err);
        return res.status(500).json({ error: "Failed to increment plusCount" });
      }
    }


    const ops = req.body || {};
    const allowed = {};


    /* ----------- shopifyNotes ----------- */
    if (typeof ops.shopifyNotes === "string") {
      allowed["orderConfirmOps.shopifyNotes"] = ops.shopifyNotes;
    }


    /* ----------- callStatus ----------- */
    if (typeof ops.callStatus === "string") {
      const up = ops.callStatus.trim().toUpperCase().replace(/\s+/g, "_");


      if (!Object.values(CallStatusEnum).includes(up)) {
        return res.status(400).json({ error: "Invalid callStatus" });
      }


      allowed["orderConfirmOps.callStatus"] = up;
      allowed["orderConfirmOps.callStatusUpdatedAt"] = new Date();
    }


    /* 👉 IMPORTANT: Track who updated the call status */
    if (allowed["orderConfirmOps.callStatus"]) {
      allowed["orderConfirmOps.callStatusUpdatedBy"] = req.user._id;
    }


    /* ----------- Doctor call needed ----------- */
    if (typeof ops.doctorCallNeeded === "boolean") {
      allowed["orderConfirmOps.doctorCallNeeded"] = !!ops.doctorCallNeeded;
      if (!ops.doctorCallNeeded) {
        allowed["orderConfirmOps.assignedExpert"] = "";
      }
    }


    /* ----------- Diet plan needed ----------- */
    if (typeof ops.dietPlanNeeded === "boolean") {
      allowed["orderConfirmOps.dietPlanNeeded"] = !!ops.dietPlanNeeded;
    }


    /* ----------- Expert assignment ----------- */
    if (typeof ops.assignedExpert === "string") {
      allowed["orderConfirmOps.assignedExpert"] = ops.assignedExpert;
    }


    /* ----------- Language used ----------- */
    if (typeof ops.languageUsed === "string") {
      allowed["orderConfirmOps.languageUsed"] = ops.languageUsed.trim();
    }


    /* ----------- COD → Prepaid ----------- */
    if (typeof ops.codToPrepaid === "boolean") {
      allowed["orderConfirmOps.codToPrepaid"] = !!ops.codToPrepaid;
      if (!ops.codToPrepaid) {
        allowed["orderConfirmOps.paymentLink"] = "";
      }
    }


    /* ----------- Payment Link ----------- */
    if (typeof ops.paymentLink === "string") {
      const order = await ShopifyOrder.findById(id, {
        "orderConfirmOps.codToPrepaid": 1,
      }).lean();


      const isCOD =
        typeof ops.codToPrepaid === "boolean"
          ? ops.codToPrepaid
          : order?.orderConfirmOps?.codToPrepaid;


      if (!isCOD) {
        return res.status(400).json({
          error: "Enable COD → Prepaid before setting payment link",
        });
      }


      allowed["orderConfirmOps.paymentLink"] = ops.paymentLink.trim();
    }


    /* ----------- Manual Assign / Unassign ----------- */
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


    const updated = await ShopifyOrder.findByIdAndUpdate(
      id,
      { $set: allowed },
      { new: true, projection: { orderConfirmOps: 1 } }
    ).lean();


    if (!updated)
      return res.status(404).json({ error: "Order not found" });


    return res.json({ ok: true, orderConfirmOps: updated.orderConfirmOps });
  } catch (err) {
    console.error("PATCH /order-confirmations/:id error:", err);
    return res.status(500).json({ error: "Failed to update order" });
  }
});




router.get("/history-by-phone", async (req, res) => {
  try {
    const raw = String(req.query.phone || "");
    const phone = normalizePhone(raw);


    if (!phone)
      return res.status(400).json({ error: "phone is required" });


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




router.post("/shopify-notes", async (req, res) => {
  try {
    const { orderName, note, userFullName: fromBody } = req.body || {};


    if (!orderName || typeof note !== "string") {
      return res.status(400).json({ error: "orderName and note required" });
    }


    if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
      return res
        .status(500)
        .json({ error: "Shopify credentials missing" });
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


    let label =
      STATUS_LABELS[up] ||
      Object.values(STATUS_LABELS).find(
        (l) => l.toLowerCase() === raw.toLowerCase()
      ) ||
      raw;


    const finalNote = userFullName ? `${label} - ${userFullName}` : label;
    const nameWithHash = ensureHashOrderName(orderName);
    const encName = encodeURIComponent(nameWithHash);


    // Find Shopify Order
    const searchResp = await shopifyApi.get(
      `/orders.json?name=${encName}&status=any&limit=1`
    );
    const shopifyOrder = Array.isArray(searchResp.data?.orders)
      ? searchResp.data.orders[0]
      : null;


    if (!shopifyOrder?.id)
      return res
        .status(404)
        .json({ error: `Shopify order not found for ${nameWithHash}` });


    const shopifyId = shopifyOrder.id;


    // Update Shopify Note
    await shopifyApi.put(`/orders/${shopifyId}.json`, {
      order: { id: shopifyId, note: finalNote },
    });


    const possibleNames = [
      nameWithHash,
      nameWithHash.startsWith("#") ? nameWithHash.slice(1) : "",
    ].filter(Boolean);


    // Update Mongo
    const mongoUpdate = await ShopifyOrder.findOneAndUpdate(
      {
        $or: [
          { orderName: { $in: possibleNames } },
          { orderId: shopifyId },
        ],
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
      shopify: { id: shopifyId, name: shopifyOrder?.name },
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
      return res.status(400).json({ error: "Invalid callStatus" });
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


router.get("/counts", async (req, res) => {
  try {
    const { q, channel, assigned, startDate, endDate } = req.query;
    const M = ShopifyOrder;
 
    const baseMatch = {};


    // DATE FILTER
    if (startDate && endDate) {
      baseMatch.orderDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }


    // SEARCH
    if (q && q.trim()) {
      const clean = q.replace(/\D/g, "");
      baseMatch.$or = [
        { orderName: { $regex: q, $options: "i" } },
        { contactNumber: clean },
        { normalizedPhone: clean },
      ];
    }


    // CHANNEL
    if (channel) {
      baseMatch.channelName = channel;
    }
 
    const assignedMatch = {};
    if (assigned && assigned !== "ALL") {
      if (assigned === "unassigned") {
        assignedMatch["orderConfirmOps.assignedAgentId"] = {
          $exists: false,
        };
      } else {
        assignedMatch["orderConfirmOps.assignedAgentId"] = assigned;
      }
    }

 
    const all = await M.countDocuments({
      ...baseMatch,
      ...assignedMatch,
    });

 
    const pending = await M.countDocuments({
      ...baseMatch,
      ...assignedMatch,
      $or: [
        { "orderConfirmOps.shopifyNotes": { $exists: false } },
        { "orderConfirmOps.shopifyNotes": "" },
      ],
    });

    const userId = getUserIdFromReq(req); 


    const cnpMatch = {
      ...baseMatch,
      "orderConfirmOps.callStatus": "CNP",
    };


    if (isValidObjectId(userId)) {
      cnpMatch["orderConfirmOps.callStatusUpdatedBy"] = userId;
    }


    const cnp = await M.countDocuments(cnpMatch);

    const allCnp = await M.countDocuments({
      ...baseMatch,
      "orderConfirmOps.callStatus": "CNP",
    });


    const confirmed = await M.countDocuments({
      ...baseMatch,
      ...assignedMatch,
      "orderConfirmOps.callStatus": "ORDER_CONFIRMED",
    });


    const callback = await M.countDocuments({
      ...baseMatch,
      ...assignedMatch,
      "orderConfirmOps.callStatus": "CALL_BACK_LATER",
    });


    const cancel = await M.countDocuments({
      ...baseMatch,
      ...assignedMatch,
      "orderConfirmOps.callStatus": "CANCEL_ORDER",
    });


    res.json({
      counts: {
        ALL: all,
        PENDING: pending,
        CNP: cnp,           // ✅ now only logged-in user’s CNPs
        ALL_CNP: allCnp,    // ✅ total CNPs in system
        ORDER_CONFIRMED: confirmed,
        CALL_BACK_LATER: callback,
        CANCEL_ORDER: cancel,
      },
    });
  } catch (err) {
    console.error("Counts error:", err);
    res.status(500).json({ error: err.message || "Count error" });
  }
});




router.get("/today-confirmed-count", async (req, res) => {
  try {
    const maybeAgentId = String(req.query.agentId || "");
    const userId = getUserIdFromReq(req);


    const agentId = isValidObjectId(maybeAgentId)
      ? new mongoose.Types.ObjectId(maybeAgentId)
      : isValidObjectId(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;




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


    const istOffset = 5.5 * 60 * 60 * 1000;


    const startUTC = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - istOffset;
    const endUTC = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - istOffset;


    const start = new Date(startUTC);
    const end = new Date(endUTC);


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
    res.status(500).json({ error: "Failed to compute today's count" });
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
      ocCancelReason = "",
    } = req.body || {};


    if (!orderName && !orderId) {
      return res.status(400).json({ error: "Provide orderName or orderId" });
    }


    if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
      return res
        .status(500)
        .json({ error: "Shopify credentials missing in environment" });
    }


    let shopifyId = null;
    let shopifyName = null;


    /* ------------------------------------------------
       1. Resolve Shopify Order ID
    ------------------------------------------------*/
    if (orderId) {
      shopifyId = String(orderId).replace(/\D/g, "");
      const { data } = await shopifyApi.get(`/orders/${shopifyId}.json`);


      if (!data?.order?.id) {
        return res
          .status(404)
          .json({ error: `Order not found for id ${orderId}` });
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
          error: `Shopify order not found for ${nameWithHash}`,
        });
      }


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
        error: "Shopify cancellation failed — unexpected response",
      });
    }

    const possibleNames = [
      shopifyName || "",
      stripHash(shopifyName || ""),
      ensureHashOrderName(shopifyName || ""),
    ].filter(Boolean);


    await ShopifyOrder.findOneAndUpdate(
      {
        $or: [
          { orderId: shopifyId },
          { orderName: { $in: possibleNames } },
        ],
      },
      {
        $set: {
          "orderConfirmOps.shopifyNotes": note,
          "orderConfirmOps.callStatus": CallStatusEnum.CANCEL_ORDER,
          "orderConfirmOps.callStatusUpdatedAt": new Date(),
          "orderConfirmOps.ocCancelReason": ocCancelReason,
        },
      }
    ).lean();


    // Try mirroring note back to Shopify again silently
    try {
      await shopifyApi.put(`/orders/${shopifyId}.json`, {
        order: { id: shopifyId, note },
      });
    } catch (_) {}


    return res.json({
      ok: true,
      shopify: { id: shopifyId, name: shopifyName },
      note,
    });
  } catch (err) {
    const code = err?.response?.status || 500;
    const details = err?.response?.data || err.message;


    console.error("POST /cancel error:", details);


    return res.status(code).json({
      error: "Cancel operation failed",
      details,
    });
  }
});

let __ocBusy = false;


cron.schedule("*/59 * * * *", async () => {
  if (__ocBusy) return;
  __ocBusy = true;


  const started = Date.now();


  try {
    // 1. Assign new orders using round robin
    const rr = await assignRoundRobin({});
    console.log(
      `[OC CRON] assigned=${rr.assigned || 0} (agents=${rr.agents || 0})`
    );


    // 2. Sync Shopify (fetch new)
    await axios.get(
      "https://muditamleads-14f32a10d7f7.herokuapp.com/api/orders-shopify/sync-new",
      { timeout: 120000 }
    );


    console.log(
      `[OC CRON] completed in ${(Date.now() - started) / 1000}s`
    );
  } catch (e) {
    console.error("[OC CRON] error:", e?.response?.data || e.message || e);
  } finally {
    __ocBusy = false;
  }
});

module.exports = router; 