// routes/cohart-dataApi.js
const express = require("express");
const router = express.Router();

// Import your existing Mongoose model (unchanged)
const ShopifyOrder = require("../models/ShopifyOrder");
const Lead = require("../models/Lead");
const Employee = require("../models/Employee");

// Utility — normalize phone to last 10 digits
function normalizePhone(phone) {
  if (!phone) return "";
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

// Quick health check
router.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /cohart-dataApi/records
 * Query params:
 *   - phone: string (required, raw phone; we normalize)
 *   - from:  ISO date (optional; inclusive lower bound)
 *   - to:    ISO date (optional; inclusive upper bound)
 *   - limit: number (default 500, max 2000)
 *   - skip:  number (default 0)
 *
 * Returns: array of ShopifyOrder docs sorted by orderDate ASC.
 */
router.get("/records", async (req, res) => {
  try {
    const { phone, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
    const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);

    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: "Missing or invalid ?phone" });

    const query = {
      $or: [
        { normalizedPhone: normalized },
        { contactNumber: { $regex: new RegExp(`${normalized}$`) } }, // fallback for legacy docs
      ],
    };

    if (from || to) {
      query.orderDate = {};
      if (from) query.orderDate.$gte = new Date(from);
      if (to) query.orderDate.$lte = new Date(to);
    }

    const projection =
      "orderId orderName customerName contactNumber normalizedPhone orderDate amount paymentGatewayNames modeOfPayment productsOrdered channelName customerAddress currency financial_status fulfillment_status";

    const docs = await ShopifyOrder.find(query, projection)
      .sort({ orderDate: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(docs);
  } catch (err) {
    console.error("GET /cohart-dataApi/records error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /cohart-dataApi/summary
 * Returns: { totalOrders, totalSpent, aov }
 */
router.get("/summary", async (req, res) => {
  try {
    const { phone, from, to } = req.query;
    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: "Missing or invalid ?phone" });

    const match = {
      $or: [
        { normalizedPhone: normalized },
        { contactNumber: { $regex: new RegExp(`${normalized}$`) } },
      ],
    };
    if (from || to) {
      match.orderDate = {};
      if (from) match.orderDate.$gte = new Date(from);
      if (to) match.orderDate.$lte = new Date(to);
    }

    const agg = await ShopifyOrder.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          totalSpent: 1,
          aov: {
            $cond: [
              { $gt: ["$totalOrders", 0] },
              { $round: [{ $divide: ["$totalSpent", "$totalOrders"] }, 2] },
              0,
            ],
          },
        },
      },
    ]);

    res.json(agg[0] || { totalOrders: 0, totalSpent: 0, aov: 0 });
  } catch (err) {
    console.error("GET /cohart-dataApi/summary error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

function normalizeProductTitle(item = {}) {
  return String(item.title || item.sku || "").trim();
}

function durationDaysFromMonthField(monthField) {
  if (!monthField || typeof monthField !== "string") return 30;
  const raw = monthField.trim().toLowerCase();

  const dayMatch = raw.match(/(\d+)\s*day/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  const monthMatch = raw.match(/(\d+)\s*month/);
  if (monthMatch) {
    const n = parseInt(monthMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n * 30 : 30;
  }

  return 30;
}

function categorizeDaysRemaining(daysRemaining) {
  if (daysRemaining < 0) return "finished";
  if (daysRemaining <= 10) return "next10Days";
  if (daysRemaining <= 20) return "next10to20Days";
  return "supply20PlusDays";
}

const PHONE_IN_CHUNK_SIZE = 1500;

async function fetchOrdersForPhones({ phones, lowerBound, projection }) {
  const normalizedPhones = Array.from(
    new Set((phones || []).map((p) => normalizePhone(p)).filter(Boolean))
  );
  if (!normalizedPhones.length) return [];

  const chunks = [];
  for (let i = 0; i < normalizedPhones.length; i += PHONE_IN_CHUNK_SIZE) {
    chunks.push(normalizedPhones.slice(i, i + PHONE_IN_CHUNK_SIZE));
  }

  const out = [];
  for (const chunk of chunks) {
    const rows = await ShopifyOrder.find(
      {
        orderDate: { $gte: lowerBound },
        $or: [
          { normalizedPhone: { $in: chunk } },
          { contactNumber: { $in: chunk } },
        ],
      },
      projection
    ).lean();
    out.push(...rows);
  }
  return out;
}

/**
 * GET /cohart-dataApi/combined-overview
 * Query params:
 *   - lookbackDays: number (optional, default 540)
 *
 * Returns bucketed customer-product supply status:
 *  - finished
 *  - next10Days
 *  - next10to20Days
 *  - supply20PlusDays
 */
router.get("/combined-overview", async (req, res) => {
  try {
    const lookbackDays = Math.max(parseInt(req.query.lookbackDays || "540", 10), 30);
    const retentionAgent = String(req.query.retentionAgent || "").trim();
    const now = new Date();
    const lowerBound = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    let allowedPhones = null;
    let totalAssignedCustomers = 0;
    if (retentionAgent && retentionAgent.toLowerCase() !== "all") {
      const leadRows = await Lead.find(
        { healthExpertAssigned: retentionAgent },
        "contactNumber"
      ).lean();

      allowedPhones = new Set(
        (leadRows || [])
          .map((l) => normalizePhone(l?.contactNumber))
          .filter(Boolean)
      );
      totalAssignedCustomers = allowedPhones.size;

      if (allowedPhones.size === 0) {
        return res.json({
          generatedAt: now.toISOString(),
          lookbackDays,
          retentionAgent,
          summary: {
            totalAssignedCustomers: 0,
            classifiedCustomers: 0,
            unclassifiedCustomers: 0,
            totalCustomerProducts: 0,
            finished: 0,
            next10Days: 0,
            next10to20Days: 0,
            supply20PlusDays: 0,
            customerCategoryBreakup: {
              finished: { count: 0, percentage: 0 },
              next10Days: { count: 0, percentage: 0 },
              next10to20Days: { count: 0, percentage: 0 },
              supply20PlusDays: { count: 0, percentage: 0 },
            },
          },
          buckets: {
            finished: [],
            next10Days: [],
            next10to20Days: [],
            supply20PlusDays: [],
          },
        });
      }
    }

    const phonesForQuery = allowedPhones ? Array.from(allowedPhones) : null;
    const docs = phonesForQuery
      ? await fetchOrdersForPhones({
          phones: phonesForQuery,
          lowerBound,
          projection: "customerName contactNumber normalizedPhone orderDate productsOrdered orderName orderId",
        })
      : await ShopifyOrder.find(
          { orderDate: { $gte: lowerBound } },
          "customerName contactNumber normalizedPhone orderDate productsOrdered orderName orderId"
        ).lean();

    const latestByCustomerProduct = new Map();

    for (const order of docs) {
      const orderDate = order?.orderDate ? new Date(order.orderDate) : null;
      if (!orderDate || Number.isNaN(orderDate.getTime())) continue;

      const phone = normalizePhone(order.normalizedPhone || order.contactNumber);
      if (!phone) continue;
      if (allowedPhones && !allowedPhones.has(phone)) continue;

      const customerName = String(order.customerName || "").trim() || "Unknown";
      const items = Array.isArray(order.productsOrdered) ? order.productsOrdered : [];

      for (const item of items) {
        const productTitle = normalizeProductTitle(item);
        if (!productTitle) continue;

        const durationDays = durationDaysFromMonthField(item.month);
        const endDate = new Date(orderDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
        const key = `${phone}__${productTitle.toLowerCase()}`;
        const prev = latestByCustomerProduct.get(key);

        if (!prev || endDate > prev.endDate) {
          latestByCustomerProduct.set(key, {
            customerName,
            contactNumber: phone,
            product: productTitle,
            monthField: item.month || "",
            durationDays,
            orderDate,
            endDate,
            orderName: order.orderName || "",
            orderId: order.orderId || "",
          });
        }
      }
    }

    const buckets = {
      finished: [],
      next10Days: [],
      next10to20Days: [],
      supply20PlusDays: [],
    };

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    for (const rec of latestByCustomerProduct.values()) {
      const daysRemaining = Math.ceil((rec.endDate.getTime() - now.getTime()) / MS_PER_DAY);
      const payload = {
        customerName: rec.customerName,
        contactNumber: rec.contactNumber,
        product: rec.product,
        orderDate: rec.orderDate,
        endDate: rec.endDate,
        daysRemaining,
        durationDays: rec.durationDays,
        monthField: rec.monthField,
        orderName: rec.orderName,
        orderId: rec.orderId,
      };

      if (daysRemaining < 0) buckets.finished.push(payload);
      else if (daysRemaining <= 10) buckets.next10Days.push(payload);
      else if (daysRemaining <= 20) buckets.next10to20Days.push(payload);
      else buckets.supply20PlusDays.push(payload);
    }

    const bySoonest = (a, b) => a.daysRemaining - b.daysRemaining;
    Object.values(buckets).forEach((arr) => arr.sort(bySoonest));

    const customerUrgency = new Map(); // phone -> category
    const rank = { finished: 0, next10Days: 1, next10to20Days: 2, supply20PlusDays: 3 };
    const pick = (daysRemaining) => {
      if (daysRemaining < 0) return "finished";
      if (daysRemaining <= 10) return "next10Days";
      if (daysRemaining <= 20) return "next10to20Days";
      return "supply20PlusDays";
    };
    for (const rec of latestByCustomerProduct.values()) {
      const cat = pick(Math.ceil((rec.endDate.getTime() - now.getTime()) / MS_PER_DAY));
      const prev = customerUrgency.get(rec.contactNumber);
      if (!prev || rank[cat] < rank[prev]) customerUrgency.set(rec.contactNumber, cat);
    }

    const customerCategoryCounts = {
      finished: 0,
      next10Days: 0,
      next10to20Days: 0,
      supply20PlusDays: 0,
    };
    for (const cat of customerUrgency.values()) customerCategoryCounts[cat] += 1;

    const classifiedCustomers = customerUrgency.size;
    const assignedBase = retentionAgent && retentionAgent.toLowerCase() !== "all"
      ? totalAssignedCustomers
      : classifiedCustomers;
    const unclassifiedCustomers = Math.max(0, assignedBase - classifiedCustomers);
    const pct = (n) => (assignedBase > 0 ? Number(((n / assignedBase) * 100).toFixed(1)) : 0);

    res.json({
      generatedAt: now.toISOString(),
      lookbackDays,
      retentionAgent: retentionAgent || "All",
      summary: {
        totalAssignedCustomers: assignedBase,
        classifiedCustomers,
        unclassifiedCustomers,
        totalCustomerProducts: latestByCustomerProduct.size,
        finished: buckets.finished.length,
        next10Days: buckets.next10Days.length,
        next10to20Days: buckets.next10to20Days.length,
        supply20PlusDays: buckets.supply20PlusDays.length,
        customerCategoryBreakup: {
          finished: { count: customerCategoryCounts.finished, percentage: pct(customerCategoryCounts.finished) },
          next10Days: { count: customerCategoryCounts.next10Days, percentage: pct(customerCategoryCounts.next10Days) },
          next10to20Days: { count: customerCategoryCounts.next10to20Days, percentage: pct(customerCategoryCounts.next10to20Days) },
          supply20PlusDays: { count: customerCategoryCounts.supply20PlusDays, percentage: pct(customerCategoryCounts.supply20PlusDays) },
        },
      },
      buckets,
    });
  } catch (err) {
    console.error("GET /cohart-dataApi/combined-overview error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/retention-agents", async (_req, res) => {
  try {
    const rows = await Employee.find(
      {
        status: "active",
        role: { $regex: /^retention agent$/i },
      },
      "fullName"
    ).lean();

    const clean = Array.from(new Set(
      (rows || []).map((r) => String(r?.fullName || "").trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    res.json({ agents: clean });
  } catch (err) {
    console.error("GET /cohart-dataApi/retention-agents error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /cohart-dataApi/active-customers-expert-summary
 * Query params:
 *   - lookbackDays: number (optional, default 540)
 *
 * Returns:
 *  - combined summary of all active customers
 *  - per-retention-expert table with active customer bucket counts
 */
router.get("/active-customers-expert-summary", async (req, res) => {
  try {
    const lookbackDays = Math.max(parseInt(req.query.lookbackDays || "540", 10), 30);
    const now = new Date();
    const lowerBound = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const [activeLeadRows, retentionExperts] = await Promise.all([
      Lead.find(
        {
          retentionStatus: { $regex: /^active$/i },
          contactNumber: { $exists: true, $ne: null, $ne: "" },
        },
        "contactNumber healthExpertAssigned"
      ).lean(),
      Employee.find(
        { status: "active", role: { $regex: /^retention agent$/i } },
        "fullName"
      ).lean(),
    ]);

    const phoneToExpert = new Map();
    for (const lead of activeLeadRows || []) {
      const phone = normalizePhone(lead?.contactNumber);
      if (!phone) continue;
      const expert = String(lead?.healthExpertAssigned || "").trim();
      if (!phoneToExpert.has(phone)) {
        phoneToExpert.set(phone, expert);
      } else if (!phoneToExpert.get(phone) && expert) {
        phoneToExpert.set(phone, expert);
      }
    }

    const activePhones = Array.from(phoneToExpert.keys());
    const activePhoneSet = new Set(activePhones);

    const expertNames = Array.from(
      new Set((retentionExperts || []).map((e) => String(e?.fullName || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    const expertNameSet = new Set(expertNames);

    const assignedActivePhones = Array.from(activePhoneSet).filter((phone) => {
      const expert = String(phoneToExpert.get(phone) || "").trim();
      return expertNameSet.has(expert);
    });

    const docs = await fetchOrdersForPhones({
      phones: assignedActivePhones,
      lowerBound,
      projection: "customerName contactNumber normalizedPhone orderDate productsOrdered orderName orderId",
    });

    const latestByCustomerProduct = new Map();
    for (const order of docs) {
      const orderDate = order?.orderDate ? new Date(order.orderDate) : null;
      if (!orderDate || Number.isNaN(orderDate.getTime())) continue;

      const phone = normalizePhone(order.normalizedPhone || order.contactNumber);
      if (!phone || !activePhoneSet.has(phone)) continue;

      const customerName = String(order.customerName || "").trim() || "Unknown";
      const items = Array.isArray(order.productsOrdered) ? order.productsOrdered : [];

      for (const item of items) {
        const productTitle = normalizeProductTitle(item);
        if (!productTitle) continue;
        const durationDays = durationDaysFromMonthField(item.month);
        const endDate = new Date(orderDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
        const key = `${phone}__${productTitle.toLowerCase()}`;
        const prev = latestByCustomerProduct.get(key);

        if (!prev || endDate > prev.endDate) {
          latestByCustomerProduct.set(key, {
            customerName,
            contactNumber: phone,
            product: productTitle,
            endDate,
          });
        }
      }
    }

    const rank = { finished: 0, next10Days: 1, next10to20Days: 2, supply20PlusDays: 3 };
    const customerUrgency = new Map(); // phone -> category (most urgent across products)
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    for (const rec of latestByCustomerProduct.values()) {
      const daysRemaining = Math.ceil((rec.endDate.getTime() - now.getTime()) / MS_PER_DAY);
      const cat = categorizeDaysRemaining(daysRemaining);
      const prev = customerUrgency.get(rec.contactNumber);
      if (!prev || rank[cat] < rank[prev]) customerUrgency.set(rec.contactNumber, cat);
    }

    const mkCounts = () => ({
      totalActiveCustomers: 0,
      finished: 0,
      next10Days: 0,
      next10to20Days: 0,
      supply20PlusDays: 0,
    });

    const combined = mkCounts();
    combined.totalActiveCustomers = assignedActivePhones.length;
    for (const phone of assignedActivePhones) {
      const cat = customerUrgency.get(phone);
      if (cat) combined[cat] += 1;
    }

    const perExpertMap = new Map();
    for (const name of expertNames) {
      perExpertMap.set(name, { healthExpert: name, ...mkCounts() });
    }

    for (const phone of activePhoneSet) {
      const expert = String(phoneToExpert.get(phone) || "").trim();
      if (!expertNameSet.has(expert)) continue;
      const row = perExpertMap.get(expert);
      row.totalActiveCustomers += 1;
      const cat = customerUrgency.get(phone);
      if (cat) row[cat] += 1;
    }

    const experts = Array.from(perExpertMap.values()).sort(
      (a, b) => b.totalActiveCustomers - a.totalActiveCustomers || a.healthExpert.localeCompare(b.healthExpert)
    );

    res.json({
      generatedAt: now.toISOString(),
      lookbackDays,
      combined,
      unassignedActiveCustomers: Math.max(0, activePhoneSet.size - assignedActivePhones.length),
      experts,
    });
  } catch (err) {
    console.error("GET /cohart-dataApi/active-customers-expert-summary error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /cohart-dataApi/active-customers-category-details
 * Query params:
 *   - lookbackDays (optional, default 540)
 *   - category: totalActive | finished | next10Days | next10to20Days | supply20PlusDays
 *   - healthExpert (optional): if provided, scope to that expert only
 */
router.get("/active-customers-category-details", async (req, res) => {
  try {
    const lookbackDays = Math.max(parseInt(req.query.lookbackDays || "540", 10), 30);
    const category = String(req.query.category || "totalActive").trim();
    const healthExpert = String(req.query.healthExpert || "").trim().toLowerCase();
    const now = new Date();
    const lowerBound = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    const activeLeadRows = await Lead.find(
      {
        retentionStatus: { $regex: /^active$/i },
        contactNumber: { $exists: true, $ne: null, $ne: "" },
      },
      "contactNumber healthExpertAssigned name"
    ).lean();

    const phoneMeta = new Map(); // phone -> { healthExpertAssigned, leadName }
    for (const lead of activeLeadRows || []) {
      const phone = normalizePhone(lead?.contactNumber);
      if (!phone) continue;
      const expert = String(lead?.healthExpertAssigned || "").trim();
      const leadName = String(lead?.name || "").trim();
      if (!phoneMeta.has(phone)) phoneMeta.set(phone, { healthExpertAssigned: expert, leadName });
      else {
        const prev = phoneMeta.get(phone);
        if (!prev.healthExpertAssigned && expert) prev.healthExpertAssigned = expert;
        if (!prev.leadName && leadName) prev.leadName = leadName;
      }
    }

    const activePhones = Array.from(phoneMeta.keys());
    const activePhoneSet = new Set(activePhones);

    const retentionExperts = await Employee.find(
      { status: "active", role: { $regex: /^retention agent$/i } },
      "fullName"
    ).lean();
    const expertNameSet = new Set(
      (retentionExperts || []).map((e) => String(e?.fullName || "").trim()).filter(Boolean)
    );

    let assignedActivePhones = activePhones.filter((phone) => {
      const expert = String(phoneMeta.get(phone)?.healthExpertAssigned || "").trim();
      return expertNameSet.has(expert);
    });

    if (healthExpert) {
      assignedActivePhones = assignedActivePhones.filter((phone) => {
        const expert = String(phoneMeta.get(phone)?.healthExpertAssigned || "").trim().toLowerCase();
        return expert === healthExpert;
      });
    }
    const assignedSet = new Set(assignedActivePhones);

    const docs = await fetchOrdersForPhones({
      phones: assignedActivePhones,
      lowerBound,
      projection: "customerName contactNumber normalizedPhone orderDate productsOrdered",
    });

    const hasPack = (v) => String(v || "").trim().length > 0;
    const variantPackMap = new Map(); // variant_id -> { pack, ts }
    const skuPackMap = new Map();     // sku -> { pack, ts }
    const titlePackMap = new Map();   // title -> { pack, ts }

    // Pass 1: learn known pack metadata from available order items
    for (const order of docs) {
      const orderDate = order?.orderDate ? new Date(order.orderDate) : null;
      if (!orderDate || Number.isNaN(orderDate.getTime())) continue;
      const ts = orderDate.getTime();
      const items = Array.isArray(order.productsOrdered) ? order.productsOrdered : [];
      for (const item of items) {
        const pack = String(item?.month || "").trim();
        if (!hasPack(pack)) continue;

        const variantId = item?.variant_id != null ? String(item.variant_id) : "";
        const sku = String(item?.sku || "").trim().toLowerCase();
        const title = normalizeProductTitle(item).toLowerCase();

        if (variantId) {
          const prev = variantPackMap.get(variantId);
          if (!prev || ts > prev.ts) variantPackMap.set(variantId, { pack, ts });
        }
        if (sku) {
          const prev = skuPackMap.get(sku);
          if (!prev || ts > prev.ts) skuPackMap.set(sku, { pack, ts });
        }
        if (title) {
          const prev = titlePackMap.get(title);
          if (!prev || ts > prev.ts) titlePackMap.set(title, { pack, ts });
        }
      }
    }

    const resolvePack = (item) => {
      const direct = String(item?.month || "").trim();
      if (hasPack(direct)) return direct;
      const variantId = item?.variant_id != null ? String(item.variant_id) : "";
      if (variantId && variantPackMap.has(variantId)) return variantPackMap.get(variantId).pack;
      const sku = String(item?.sku || "").trim().toLowerCase();
      if (sku && skuPackMap.has(sku)) return skuPackMap.get(sku).pack;
      const title = normalizeProductTitle(item).toLowerCase();
      if (title && titlePackMap.has(title)) return titlePackMap.get(title).pack;
      return "Pack N/A";
    };

    const latestByCustomerProduct = new Map(); // phone__product -> { endDate, orderDate, product }
    const customerMeta = new Map(); // phone -> { customerName, lastOrderDate, productsMap, orderIds }
    for (const order of docs) {
      const orderDate = order?.orderDate ? new Date(order.orderDate) : null;
      if (!orderDate || Number.isNaN(orderDate.getTime())) continue;

      const phone = normalizePhone(order.normalizedPhone || order.contactNumber);
      if (!phone || !activePhoneSet.has(phone) || !assignedSet.has(phone)) continue;

      const customerName = String(order.customerName || "").trim() || "";
      const meta = customerMeta.get(phone) || {
        customerName: customerName || String(phoneMeta.get(phone)?.leadName || "").trim() || "Unknown",
        lastOrderDate: orderDate,
        productsMap: new Map(), // productKey -> { product, pack, orderDate }
        orderIds: new Set(),
      };
      if (orderDate > meta.lastOrderDate) meta.lastOrderDate = orderDate;
      const orderUniqueKey = order?._id ? String(order._id) : `${phone}__${orderDate.toISOString()}`;
      meta.orderIds.add(orderUniqueKey);

      const items = Array.isArray(order.productsOrdered) ? order.productsOrdered : [];
      for (const item of items) {
        const productTitle = normalizeProductTitle(item);
        if (!productTitle) continue;
        const productKey = productTitle.toLowerCase();
        const pack = resolvePack(item);
        const prevProduct = meta.productsMap.get(productKey);
        if (!prevProduct || orderDate > prevProduct.orderDate) {
          meta.productsMap.set(productKey, { product: productTitle, pack, orderDate });
        }
        const durationDays = durationDaysFromMonthField(item.month);
        const endDate = new Date(orderDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
        const key = `${phone}__${productTitle.toLowerCase()}`;
        const prev = latestByCustomerProduct.get(key);
        if (!prev || endDate > prev.endDate) {
          latestByCustomerProduct.set(key, { endDate, orderDate, product: productTitle });
        }
      }
      customerMeta.set(phone, meta);
    }

    const rank = { finished: 0, next10Days: 1, next10to20Days: 2, supply20PlusDays: 3 };
    const customerUrgency = new Map(); // phone -> category
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    for (const [key, rec] of latestByCustomerProduct.entries()) {
      const phone = key.split("__")[0];
      const daysRemaining = Math.ceil((rec.endDate.getTime() - now.getTime()) / MS_PER_DAY);
      const cat = categorizeDaysRemaining(daysRemaining);
      const prev = customerUrgency.get(phone);
      if (!prev || rank[cat] < rank[prev]) customerUrgency.set(phone, cat);
    }

    const valid = new Set(["totalActive", "finished", "next10Days", "next10to20Days", "supply20PlusDays"]);
    const target = valid.has(category) ? category : "totalActive";

    let phonesForCategory = assignedActivePhones;
    if (target !== "totalActive") {
      phonesForCategory = assignedActivePhones.filter((phone) => customerUrgency.get(phone) === target);
    }

    const rows = phonesForCategory.map((phone) => {
      const meta = customerMeta.get(phone) || { customerName: "Unknown", lastOrderDate: null, productsMap: new Map(), orderIds: new Set() };
      const productsOrdered = Array.from(meta.productsMap.values()).map(
        (p) => `${p.product} (${p.pack})`
      );
      return {
        customerName: meta.customerName || "Unknown",
        contactNumber: phone,
        productsOrdered,
        lastOrderDate: meta.lastOrderDate || null,
        totalOrders: meta.orderIds.size || 0,
      };
    }).sort((a, b) => {
      const da = a.lastOrderDate ? new Date(a.lastOrderDate).getTime() : 0;
      const db = b.lastOrderDate ? new Date(b.lastOrderDate).getTime() : 0;
      return db - da;
    });

    res.json({
      category: target,
      lookbackDays,
      total: rows.length,
      rows,
    });
  } catch (err) {
    console.error("GET /cohart-dataApi/active-customers-category-details error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
