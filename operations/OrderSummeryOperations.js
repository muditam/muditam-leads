const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const ShopifyOrder = require("../models/ShopifyOrder");

const EXCLUDED_STATUSES = ["Delivered", "RTO Delivered"];

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function getOrderIdVariants(orderId) {
  const raw = String(orderId || "").trim();
  const digits = digitsOnly(raw);

  const variants = new Set();

  if (raw) {
    variants.add(raw);
    if (!raw.startsWith("#")) variants.add(`#${raw}`);
  }

  if (digits) {
    variants.add(digits);
    variants.add(`#${digits}`);

    const asNumString = String(Number(digits));
    if (asNumString && asNumString !== "NaN") {
      variants.add(asNumString);
      variants.add(`#${asNumString}`);
    }
  }

  return [...variants].filter(Boolean);
}

async function attachFinancialStatus(orders = []) {
  if (!orders.length) return orders;

  const rawOrderIds = [
    ...new Set(
      orders
        .map((o) => String(o.order_id || "").trim())
        .filter(Boolean)
    ),
  ];

  const numericOrderIds = [
    ...new Set(
      rawOrderIds
        .map((id) => digitsOnly(id))
        .filter(Boolean)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n))
    ),
  ];

  const orderNameCandidates = [
    ...new Set(rawOrderIds.flatMap((id) => getOrderIdVariants(id))),
  ];

  if (!numericOrderIds.length && !orderNameCandidates.length) {
    return orders.map((o) => ({ ...o, financial_status: "" }));
  }

  const shopifyQuery = {
    $or: [
      ...(numericOrderIds.length ? [{ orderId: { $in: numericOrderIds } }] : []),
      ...(orderNameCandidates.length ? [{ orderName: { $in: orderNameCandidates } }] : []),
    ],
  };

  const shopifyOrders = await ShopifyOrder.find(shopifyQuery)
    .select("orderId orderName financial_status")
    .lean();

  const financialStatusMap = {};

  shopifyOrders.forEach((so) => {
    const financialStatus = so.financial_status || "";

    if (so.orderId !== undefined && so.orderId !== null) {
      getOrderIdVariants(String(so.orderId)).forEach((key) => {
        if (!financialStatusMap[key]) financialStatusMap[key] = financialStatus;
      });
    }

    if (so.orderName) {
      getOrderIdVariants(String(so.orderName)).forEach((key) => {
        if (!financialStatusMap[key]) financialStatusMap[key] = financialStatus;
      });
    }
  });

  return orders.map((order) => {
    const variants = getOrderIdVariants(order.order_id);
    const financial_status =
      variants.map((v) => financialStatusMap[v]).find(Boolean) || "";

    return {
      ...order,
      financial_status,
    };
  });
}

router.get("/order-counts", async (req, res) => {
  try {
    const counts = await Order.aggregate([
      {
        $match: {
          contact_number: { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: "$contact_number",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          contact_number: "$_id",
          count: 1,
        },
      },
    ]);

    const countMap = {};
    counts.forEach((item) => {
      countMap[item.contact_number] = item.count;
    });

    res.json(countMap);
  } catch (err) {
    console.error("Error fetching order counts:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.patch("/ops-meta/by-order-id", async (req, res) => {
  try {
    const { order_id, opsRemark, assignedAgentId } = req.body;

    if (!order_id) {
      return res.status(400).json({ message: "order_id is required" });
    }

    const updateData = {
      last_updated_at: new Date(),
    };

    if (opsRemark !== undefined) {
      updateData.opsRemark = String(opsRemark || "").trim();
    }

    if (assignedAgentId !== undefined) {
      updateData.assignedAgentId = assignedAgentId || null;
    }

    const updatedOrder = await Order.findOneAndUpdate(
      { order_id },
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("order_id opsRemark assignedAgentId last_updated_at");

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json({
      success: true,
      order: updatedOrder,
      message: "Ops metadata updated successfully",
    });
  } catch (err) {
    console.error("Error updating ops metadata:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET endpoint with server-side filtering + financial_status from ShopifyOrder
router.get("/undelivered-orders", async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const statusFilter = req.query.status;
    const carrierFilter = req.query.carrier;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const viewTab = req.query.viewTab; // 'pending' or 'processed'
    const selectedAgent = req.query.selectedAgent;

    const filter = {
      shipment_status: { $nin: EXCLUDED_STATUSES },
    };

    if (startDate || endDate) {
      filter.order_date = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        filter.order_date.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.order_date.$lte = end;
      }
    }

    if (statusFilter && !EXCLUDED_STATUSES.includes(statusFilter)) {
      filter.shipment_status = statusFilter;
    }

    if (carrierFilter) {
      filter.carrier_title = carrierFilter;
    }

    if (viewTab === "pending") {
      filter.$or = [
        { opsRemark: { $exists: false } },
        { opsRemark: "" },
        { opsRemark: null },
      ];
    } else if (viewTab === "processed") {
      filter.opsRemark = { $exists: true, $nin: ["", null] };

      if (selectedAgent) {
        if (selectedAgent === "unassigned") {
          filter.$or = [
            { assignedAgentId: { $exists: false } },
            { assignedAgentId: null },
          ];
        } else {
          filter.assignedAgentId = selectedAgent;
        }
      }
    }

    const orders = await Order.find(filter)
      .select(
        "order_id contact_number full_name shipment_status order_date tracking_number carrier_title opsRemark assignedAgentId last_updated_at"
      )
      .sort({ last_updated_at: -1, order_date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const enrichedOrders = await attachFinancialStatus(orders);

    const totalCount = await Order.countDocuments(filter);

    const statusFilterBase = {
      shipment_status: { $nin: EXCLUDED_STATUSES },
    };

    if (startDate || endDate) {
      statusFilterBase.order_date = filter.order_date;
    }

    if (carrierFilter) {
      statusFilterBase.carrier_title = carrierFilter;
    }

    const statusCounts = await Order.aggregate([
      { $match: statusFilterBase },
      {
        $group: {
          _id: "$shipment_status",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          shipment_status: "$_id",
          count: 1,
          _id: 0,
        },
      },
      { $sort: { count: -1 } },
    ]);

    const carrierList = await Order.distinct("carrier_title", statusFilterBase);

    res.json({
      orders: enrichedOrders,
      totalCount,
      statusCounts,
      carriers: carrierList.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

module.exports = router;