const mongoose = require("mongoose");
const express = require("express");
const router = express.Router();

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const MyOrder = require("../models/MyOrder");
const Order = require("../models/Order"); // 👈 NEW: Shipway / Order status source

// Normalize phone to last 10 digits
const normalizePhone = (p) => {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// Utility: Validate MongoDB ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * GET /api/merged-sales
 * Query params:
 *  - agentAssignedName (optional)
 *  - page (default 1)
 *  - limit (default 50)
 */
router.get("/", async (req, res) => {
  const { agentAssignedName, page = 1, limit = 50 } = req.query;
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 50;
  const skip = (pageNum - 1) * limitNum;

  try {
    // 1) Leads with salesStatus "Sales Done" (optionally agent filter)
    const leadQuery = { salesStatus: "Sales Done" };
    if (agentAssignedName) leadQuery.agentAssigned = agentAssignedName;

    const leads = await Lead.find(leadQuery).lean();

    // (kept: customers in case you need later)
    const customerQuery = {};
    if (agentAssignedName) customerQuery.assignedTo = agentAssignedName;
    const customers = await Customer.find(customerQuery).lean(); // eslint: used later if needed

    // 2) MyOrders (apply agent filter only if provided)
    const orderQuery = {};
    if (agentAssignedName) {
      orderQuery.agentName = { $regex: new RegExp(agentAssignedName, "i") };
    }
    const allMyOrders = await MyOrder.find(orderQuery).lean();

    // 3) Build ordersByPhone => Array of orders (NOT single item)
    const ordersByPhone = {};
    allMyOrders.forEach((order) => {
      const key = normalizePhone(order.phone);
      if (!key) return;
      if (!ordersByPhone[key]) ordersByPhone[key] = [];
      ordersByPhone[key].push(order);
    });

    // Sort each phone's orders by orderDate DESC (latest first)
    Object.values(ordersByPhone).forEach((arr) =>
      arr.sort(
        (a, b) =>
          new Date(b.orderDate || 0).getTime() - new Date(a.orderDate || 0).getTime()
      )
    );

    // 4) Merge
    const seenOrderIds = new Set();
    const merged = [];
    const seenPhones = new Set(); // for detecting orders without any lead

    // For each lead: if multiple orders on that phone, create one row per order.
    // If no orders, still create a row for the lead (editable lead).
    leads.forEach((lead) => {
      const phone = normalizePhone(lead.contactNumber);
      if (phone) seenPhones.add(phone);

      const orders = phone && ordersByPhone[phone] ? ordersByPhone[phone] : [];

      if (orders.length > 0) {
        orders.forEach((order) => {
          seenOrderIds.add(String(order._id));
          merged.push({
            // Keep lead id here so editing lead-fields uses lead id
            _id: lead._id,

            // Lead-like fields
            name: lead.name || order.customerName || "",
            contactNumber: lead.contactNumber || order.phone || "",
            productsOrdered:
              lead.productsOrdered ||
              (order.productOrdered ? [order.productOrdered] : []),
            dosageOrdered: lead.dosageOrdered || order.dosageOrdered || "",
            amountPaid: lead.amountPaid ?? order.totalPrice ?? "",
            partialPayment: lead.partialPayment ?? order.partialPayment ?? 0,
            modeOfPayment: lead.modeOfPayment || order.paymentMethod || "",
            lastOrderDate: lead.lastOrderDate || order.orderDate || "",
            salesStatus: lead.salesStatus || "Sales Done",
            agentAssigned: lead.agentAssigned || order.agentName || "",
            agentsRemarks: lead.agentsRemarks || order.selfRemark || "",
            shipmentStatus: lead.shipmentStatus || "", // will be overwritten from Order

            // Order payload, include the Mongo _id so FE can PUT to order directly
            myOrderData: {
              _id: order._id,
              orderDate: order.orderDate || "",
              productOrdered: order.productOrdered || "",
              dosageOrdered: order.dosageOrdered || "",
              totalPrice: order.totalPrice ?? "",
              paymentMethod: order.paymentMethod || "",
              partialPayment: order.partialPayment ?? 0,
              selfRemark: order.selfRemark || "",
              orderId: order.orderId || "",
              shipmentStatus: order.shipmentStatus || "", // will be overwritten from Order
            },
          });
        });
      } else {
        // No order yet; keep a pure lead row (editable lead)
        merged.push({
          _id: lead._id,
          name: lead.name || "",
          contactNumber: lead.contactNumber || "",
          productsOrdered: lead.productsOrdered || [],
          dosageOrdered: lead.dosageOrdered || "",
          amountPaid: lead.amountPaid ?? "",
          partialPayment: lead.partialPayment ?? 0,
          modeOfPayment: lead.modeOfPayment || "",
          lastOrderDate: lead.lastOrderDate || "",
          salesStatus: lead.salesStatus || "Sales Done",
          agentAssigned: lead.agentAssigned || "",
          agentsRemarks: lead.agentsRemarks || "",
          shipmentStatus: lead.shipmentStatus || "",
          myOrderData: null,
        });
      }
    });

    // 5) Add orders that have no matching lead (one row per order)
    allMyOrders.forEach((order) => {
      const phone = normalizePhone(order.phone);
      const alreadyInLeadTable = phone && seenPhones.has(phone);
      if (seenOrderIds.has(String(order._id))) return; // handled above

      if (!alreadyInLeadTable) {
        merged.push({
          // IMPORTANT: use the order's id so edits target MyOrder when no lead exists
          _id: order._id,

          name: order.customerName || "",
          contactNumber: order.phone || "",
          productsOrdered: [order.productOrdered].filter(Boolean),
          dosageOrdered: order.dosageOrdered || "",
          amountPaid: order.totalPrice ?? "",
          partialPayment: order.partialPayment ?? 0,
          modeOfPayment: order.paymentMethod || "",
          lastOrderDate: order.orderDate || "",
          salesStatus: "Sales Done",
          agentAssigned: order.agentName || "",
          agentsRemarks: order.selfRemark || "",
          shipmentStatus: order.shipmentStatus || "", // will be overwritten from Order

          myOrderData: {
            _id: order._id,
            orderDate: order.orderDate || "",
            productOrdered: order.productOrdered || "",
            dosageOrdered: order.dosageOrdered || "",
            totalPrice: order.totalPrice ?? "",
            paymentMethod: order.paymentMethod || "",
            partialPayment: order.partialPayment ?? 0,
            selfRemark: order.selfRemark || "",
            orderId: order.orderId || "",
            shipmentStatus: order.shipmentStatus || "",
          },
        });
      }
    });

    // 6) 🔗 Hydrate shipment status from Order collection (Shipway)
    const orderIdSet = new Set();

    merged.forEach((row) => {
      const rawId = row.myOrderData?.orderId || "";
      if (!rawId) return;

      // Normalize orderId (remove leading '#') to match Order.order_id
      const normalized = String(rawId).replace(/^#/, "");
      if (normalized) orderIdSet.add(normalized);
    });

    let statusByOrderId = {};
    if (orderIdSet.size > 0) {
      const orderDocs = await Order.find(
        { order_id: { $in: Array.from(orderIdSet) } },
        { order_id: 1, shipment_status: 1 }
      ).lean();

      statusByOrderId = orderDocs.reduce((acc, doc) => {
        acc[String(doc.order_id)] = doc.shipment_status || "";
        return acc;
      }, {});
    }

    // Inject shipmentStatus into each merged row & its myOrderData
    merged.forEach((row) => {
      const rawId = row.myOrderData?.orderId || "";
      if (!rawId) return;

      const normalized = String(rawId).replace(/^#/, "");
      const shipStatus = statusByOrderId[normalized] || row.shipmentStatus || "";

      row.shipmentStatus = shipStatus;
      if (row.myOrderData) {
        row.myOrderData.shipmentStatus = shipStatus;
      }
    });

    // 7) Sort by latest relevant date
    merged.sort((a, b) => {
      const aDate = new Date(
        (a.myOrderData && a.myOrderData.orderDate) || a.lastOrderDate || 0
      ).getTime();
      const bDate = new Date(
        (b.myOrderData && b.myOrderData.orderDate) || b.lastOrderDate || 0
      ).getTime();
      return bDate - aDate; // DESC
    });

    // 8) Paginate
    const paginated = merged.slice(skip, skip + limitNum);

    res.json({
      sales: paginated,
      totalSales: merged.length,
    });
  } catch (error) {
    console.error("Error in merged-sales API:", error);
    res.status(500).json({ error: "Failed to fetch merged sales" });
  }
});

/**
 * PUT /api/merged-sales/:id
 * Auto-detects whether :id belongs to Lead or MyOrder
 */
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }

  try {
    // Try Lead first
    const existingLead = await Lead.findById(id);
    if (existingLead) {
      const updated = await Lead.findByIdAndUpdate(id, updates, { new: true });
      return res.status(200).json({ source: "lead", updated });
    }

    // Then MyOrder
    const existingOrder = await MyOrder.findById(id);
    if (existingOrder) {
      const updated = await MyOrder.findByIdAndUpdate(id, updates, { new: true });
      return res.status(200).json({ source: "order", updated });
    }

    return res
      .status(404)
      .json({ message: "Record not found in Lead or MyOrder" });
  } catch (err) {
    console.error("Error updating merged sale:", err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});

module.exports = router;
