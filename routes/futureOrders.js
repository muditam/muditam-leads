const express = require("express");
const FutureOrder = require("../models/FutureOrder");
const MyOrder = require("../models/MyOrder");
const requireSession = require("../middleware/requireSession");

const router = express.Router();

const PRODUCT_ABBREVIATIONS = {
  "Karela Jamun Fizz": "KJF",
  "Sugar Defend Pro": "SDP",
  "Vasant Kusmakar Ras": "VKR",
  "Liver Fix": "L-Fx",
  "Stress & Sleep": "S&S",
  "Chandraprabha Vati": "CPV",
  "Heart Defend Pro": "HDP",
  "Performance Forever": "PF",
  "Power Gut": "PGut",
  "Shilajit with Gold": "Shilajit",
  "Diabetes Management Kit": "Kit",
};

function startOfToday() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Date(`${formatter.format(new Date())}T00:00:00+05:30`);
}

function parseISTDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatAddress(address = {}) {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.country,
    address.zip,
  ]
    .filter(Boolean)
    .join(", ") || "N/A";
}

function productOrderedText(items = []) {
  return items
    .map((item) => PRODUCT_ABBREVIATIONS[item.title] || item.title || item.sku)
    .filter(Boolean)
    .join(", ") || "N/A";
}

function buildPendingMyOrderPayload(futureOrder) {
  const details = futureOrder.orderDetails || {};
  const paymentMethod = futureOrder.paymentMode || futureOrder.shopifyOrderPayload?.paymentMode || "";
  const isPartial = paymentMethod === "Partial Paid";
  const totalPrice = Number(details.upsellAmount || 0) > 0
    ? Number(details.upsellAmount || 0)
    : Number(futureOrder.orderTotal || 0);

  return {
    customerName: futureOrder.customerName || "N/A",
    phone: futureOrder.phoneNumber || futureOrder.shippingAddress?.phone || "N/A",
    shippingAddress: formatAddress(futureOrder.shippingAddress),
    paymentStatus: futureOrder.paymentStatus || "",
    productOrdered: productOrderedText(futureOrder.cartItems || []),
    orderDate: futureOrder.createdAt || new Date(),
    orderId: " ",
    totalPrice,
    agentName: details.agentName || futureOrder.createdBy || "N/A",
    partialPayment: isPartial ? Number(futureOrder.partialPaidAmount || 0) : 0,
    dosageOrdered: details.dosageOrdered || "10-Days",
    selfRemark: details.selfRemark || "",
    paymentMethod,
    upsellAmount: Number(details.upsellAmount || 0),
    transactionId: futureOrder.transactionId || "",
  };
}

router.post("/", requireSession, async (req, res) => {
  try {
    const {
      scheduledDate,
      orderData,
      cartDetails = [],
      customerName = "",
      phoneNumber = "",
      orderDetails = {},
    } = req.body || {};

    if (!scheduledDate) {
      return res.status(400).json({ message: "Future delivery date is required." });
    }
    const date = parseISTDate(scheduledDate);
    if (!date || date <= startOfToday()) {
      return res.status(400).json({ message: "Please select a valid future delivery date." });
    }
    if (!orderData || !Array.isArray(orderData.cartItems) || orderData.cartItems.length === 0) {
      return res.status(400).json({ message: "Cart items are required." });
    }

    const sessionUser = req.sessionUser || {};
    const doc = await FutureOrder.create({
      customerName,
      phoneNumber: phoneNumber || orderData.shippingAddress?.phone || "",
      customerId: orderData.customerId || "",
      scheduledDate: date,
      paymentMode: orderData.paymentMode || "",
      paymentStatus: orderData.paymentStatus || "",
      transactionId: orderData.transactionId || "",
      partialPaidAmount: Number(orderData.partialPaidAmount || 0),
      orderTotal: Number(orderData.orderTotal || 0),
      shippingCost: Number(orderData.shippingCost || 0),
      appliedDiscount: Number(orderData.appliedDiscount || 0),
      shippingAddress: orderData.shippingAddress || {},
      billingAddress: orderData.billingAddress || {},
      cartItems: cartDetails,
      shopifyOrderPayload: {
        ...orderData,
        note: String(orderDetails.orderNote || orderData.note || "").trim(),
      },
      orderDetails: {
        agentName: orderDetails.agentName || sessionUser.fullName || sessionUser.name || "",
        dosageOrdered: orderDetails.dosageOrdered || "10-Days",
        selfRemark: orderDetails.selfRemark || "",
        orderNote: orderDetails.orderNote || "",
        upsellAmount: Number(orderDetails.upsellAmount || 0),
        discount: Number(orderData.appliedDiscount || 0),
        discountType: orderDetails.discountType || "percentage",
      },
      createdBy: sessionUser.fullName || sessionUser.name || "",
      createdByEmail: sessionUser.email || "",
    });

    return res.status(201).json({ message: "Future order saved.", order: doc });
  } catch (error) {
    console.error("POST /api/future-orders error:", error);
    return res.status(500).json({ message: "Failed to save future order." });
  }
});

router.get("/", requireSession, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "25", 10)));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "pending").trim();

    const query = {};
    if (status && status !== "all") query.status = status;
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { customerName: regex },
        { phoneNumber: regex },
        { paymentMode: regex },
        { createdBy: regex },
      ];
    }

    const [items, total] = await Promise.all([
      FutureOrder.find(query)
        .sort({ scheduledDate: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      FutureOrder.countDocuments(query),
    ]);

    return res.json({ items, total, page, limit });
  } catch (error) {
    console.error("GET /api/future-orders error:", error);
    return res.status(500).json({ message: "Failed to load future orders." });
  }
});

router.patch("/:id/note", requireSession, async (req, res) => {
  try {
    const note = String(req.body?.note || "").trim();
    if (!note) {
      return res.status(400).json({ message: "Order note is required." });
    }

    const updated = await FutureOrder.findOneAndUpdate(
      { _id: req.params.id, status: "pending" },
      {
        $set: {
          "orderDetails.orderNote": note,
          "shopifyOrderPayload.note": note,
        },
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Pending future order not found." });
    }

    return res.json({ message: "Future order note saved.", order: updated });
  } catch (error) {
    console.error("PATCH /api/future-orders/:id/note error:", error);
    return res.status(500).json({ message: "Failed to save future order note." });
  }
});

router.patch("/:id/details", requireSession, async (req, res) => {
  try {
    const {
      agentName = "",
      dosageOrdered = "10-Days",
      selfRemark = "",
      upsellAmount = 0,
      discount = 0,
      discountType = "percentage",
      paymentMethod = "",
      partialPayment = 0,
      transactionId = "",
    } = req.body || {};

    const update = {
      "orderDetails.agentName": agentName,
      "orderDetails.dosageOrdered": dosageOrdered,
      "orderDetails.selfRemark": selfRemark,
      "orderDetails.upsellAmount": Number(upsellAmount || 0),
      "orderDetails.discount": Number(discount || 0),
      "orderDetails.discountType": discountType,
      appliedDiscount: Number(discount || 0),
      "shopifyOrderPayload.appliedDiscount": Number(discount || 0),
    };

    if (paymentMethod) {
      update.paymentMode = paymentMethod;
      update["shopifyOrderPayload.paymentMode"] = paymentMethod;
    }
    if (paymentMethod === "Partial Paid") {
      update.partialPaidAmount = Number(partialPayment || 0);
      update["shopifyOrderPayload.partialPaidAmount"] = Number(partialPayment || 0);
    }
    if (transactionId) {
      update.transactionId = transactionId;
      update["shopifyOrderPayload.transactionId"] = transactionId;
    }

    const updated = await FutureOrder.findOneAndUpdate(
      { _id: req.params.id, status: "pending" },
      { $set: update },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Pending future order not found." });
    }

    const myOrderPayload = buildPendingMyOrderPayload(updated);
    let myOrder = updated.myOrderId
      ? await MyOrder.findByIdAndUpdate(updated.myOrderId, myOrderPayload, { new: true })
      : await MyOrder.create(myOrderPayload);
    if (!myOrder) {
      myOrder = await MyOrder.create(myOrderPayload);
    }

    if (String(updated.myOrderId || "") !== String(myOrder._id)) {
      updated.myOrderId = myOrder._id;
      await updated.save();
    }

    return res.json({ message: "Future order details saved.", order: updated, myOrder });
  } catch (error) {
    console.error("PATCH /api/future-orders/:id/details error:", error);
    return res.status(500).json({ message: "Failed to save future order details." });
  }
});

router.delete("/:id", requireSession, async (req, res) => {
  try {
    const futureOrder = await FutureOrder.findById(req.params.id);

    if (!futureOrder) {
      return res.status(404).json({ message: "Future order not found." });
    }
    if (futureOrder.status === "processing") {
      return res.status(409).json({ message: "Future order is currently processing and cannot be deleted." });
    }

    await FutureOrder.deleteOne({ _id: futureOrder._id });

    if (futureOrder.myOrderId && futureOrder.status !== "placed") {
      await MyOrder.deleteOne({ _id: futureOrder.myOrderId });
    }

    return res.json({ message: "Future order deleted." });
  } catch (error) {
    console.error("DELETE /api/future-orders/:id error:", error);
    return res.status(500).json({ message: "Failed to delete future order." });
  }
});

router.post("/:id/place", requireSession, async (req, res) => {
  try {
    const { processFutureOrder } = require("../services/futureOrderScheduler");
    const result = await processFutureOrder(req.params.id, {
      markAsPaid: req.body?.markAsPaid === true,
    });
    if (!result) {
      return res.status(409).json({ message: "Future order is not pending or is already processing." });
    }

    return res.json({
      message: "Future order placed on Shopify.",
      order: result.futureOrder,
      shopifyOrder: result.shopifyOrder,
    });
  } catch (error) {
    console.error("POST /api/future-orders/:id/place error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to place future order.",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
