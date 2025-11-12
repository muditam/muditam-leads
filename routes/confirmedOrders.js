

const express = require("express");
const router = express.Router();
const ShopifyOrder = require("../models/ShopifyOrder");
// keep in sync with your main OC router
const CallStatusEnum = {
  CNP: "CNP",
  ORDER_CONFIRMED: "ORDER_CONFIRMED",
  CALL_BACK_LATER: "CALL_BACK_LATER",
  CANCEL_ORDER: "CANCEL_ORDER",
};
// helper: build date range on callStatusUpdatedAt for presets
function buildRangeClause(rangeKey) {
  const key = String(rangeKey || "").toLowerCase();
  if (!key || key === "all" || key === "custom") return {};
  const now = new Date();
  let start, end;
  const setDayBounds = (d) => {
    d.setHours(0, 0, 0, 0);
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return { start: d, end: e };
  };
  if (key === "today") {
    ({ start, end } = setDayBounds(new Date()));
  } else if (key === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    ({ start, end } = setDayBounds(y));
  } else if (key === "week") {
    end = new Date();
    end.setHours(23, 59, 59, 999);
    start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (key === "month") {
    const y = now.getFullYear();
    const m = now.getMonth();
    start = new Date(y, m, 1, 0, 0, 0, 0);
    end = new Date(y, m + 1, 0, 23, 59, 59, 999);
  } else {
    return {};
  }
  const clause = {};
  if (start) clause.$gte = start;
  if (end) clause.$lte = end;
  return clause;
}
// GET /api/order-confirmation/confirmed-order
router.get("/confirmed-order", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      startDate = "",
      endDate = "",
      range = "all",
    } = req.query;


    const numericPage = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));


    const clauses = [
      { "orderConfirmOps.callStatus": CallStatusEnum.ORDER_CONFIRMED },
      { financial_status: /^pending$/i },
      {
        $or: [
          { fulfillment_status: { $exists: false } },
          { fulfillment_status: { $not: /^fulfilled$/i } },
        ],
      },
    ];
    let dtClause = buildRangeClause(range);
    if (!Object.keys(dtClause).length && (startDate || endDate)) {
      const tmp = {};
      if (startDate) {
        const sd = new Date(startDate);
        if (!isNaN(sd.getTime())) tmp.$gte = sd;
      }
      if (endDate) {
        const ed = new Date(endDate);
        if (!isNaN(ed.getTime())) {
          ed.setHours(23, 59, 59, 999);
          tmp.$lte = ed;
        }
      }
      if (Object.keys(tmp).length) dtClause = tmp;
    }
    if (Object.keys(dtClause).length) {
      clauses.push({
        "orderConfirmOps.callStatusUpdatedAt": dtClause,
      });
    }
    const filter = { $and: clauses };
    const projection = {
      orderDate: 1,
      orderName: 1,
      customerName: 1,
      contactNumber: 1,
      normalizedPhone: 1,
      productsOrdered: 1,
      channelName: 1,
      amount: 1,
      currency: 1,
      "orderConfirmOps.callStatusUpdatedAt": 1,
    };


    const [docs, total] = await Promise.all([
      ShopifyOrder.find(filter, projection)
        .sort({ "orderConfirmOps.callStatusUpdatedAt": -1, orderDate: -1 })
        .skip((numericPage - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      ShopifyOrder.countDocuments(filter),
    ]);


    const items = docs.map((doc) => ({
      id: String(doc._id),
      orderDateTime: doc.orderDate || null,
      ocDateTime:
        (doc.orderConfirmOps &&
          doc.orderConfirmOps.callStatusUpdatedAt) ||
        null,
      orderName: doc.orderName || "",
      mobile: doc.normalizedPhone || doc.contactNumber || "",
      products: Array.isArray(doc.productsOrdered) ? doc.productsOrdered : [],
      channel: doc.channelName || "",
      amount: doc.amount || 0,
      currency: doc.currency || "INR",
      customerName: doc.customerName || "",
    }));


    res.json({
      page: numericPage,
      limit: pageSize,
      total,
      range,
      items,
    });
  } catch (err) {
    console.error("GET /confirmed-order error:", err);
    res.status(500).json({ error: "Failed to fetch confirmed orders" });
  }
});


module.exports = router;



