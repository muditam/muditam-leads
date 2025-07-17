const mongoose = require("mongoose");
const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const MyOrder = require("../models/MyOrder");

// Normalize phone to last 10 digits
const normalizePhone = (p) => {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

router.get("/", async (req, res) => {
  const { agentAssignedName, page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  try {
    // 1. Fetch Leads with "Sales Done" and agent
    const leadQuery = { salesStatus: "Sales Done" };
    if (agentAssignedName) leadQuery.agentAssigned = agentAssignedName;

    const leads = await Lead.find(leadQuery).lean();
    const totalLeads = leads.length;

    // 2. Fetch Customers (currently unused, kept for potential future use)
    const customerQuery = {};
    if (agentAssignedName) customerQuery.assignedTo = agentAssignedName;
    const customers = await Customer.find(customerQuery).lean();

    // 3. Fetch MyOrders with agent filter
    const allMyOrders = await MyOrder.find({
      agentName: { $regex: new RegExp(agentAssignedName, "i") },
    }).lean();

    const myOrdersMap = {};
    allMyOrders.forEach((order) => {
      const key = normalizePhone(order.phone);
      if (key) myOrdersMap[key] = order;
    });

    // 4. Merge data
    const seenPhones = new Set();
    const merged = [];

    // Leads with MyOrders
    leads.forEach((lead) => {
      const phone = normalizePhone(lead.contactNumber);
      seenPhones.add(phone);
      const order = myOrdersMap[phone];

      merged.push({
        ...lead,
        myOrderData: order
          ? {
              orderDate: order.orderDate,
              productOrdered: order.productOrdered,
              dosageOrdered: order.dosageOrdered,
              totalPrice: order.totalPrice,
              paymentMethod: order.paymentMethod,
              partialPayment: order.partialPayment,
              selfRemark: order.selfRemark,
              orderId: order.orderId || "",
              shipmentStatus: "",
            }
          : null,
      });
    });

    // MyOrders without matching leads
    Object.keys(myOrdersMap).forEach((phone) => {
      if (!seenPhones.has(phone)) {
        seenPhones.add(phone);
        const order = myOrdersMap[phone];
        merged.push({
          _id: order._id, // ✅ Critical fix: make sure we include a valid Mongo ObjectId
          name: order.customerName || "",
          contactNumber: order.phone || "",
          productsOrdered: [order.productOrdered],
          dosageOrdered: order.dosageOrdered,
          amountPaid: order.totalPrice,
          modeOfPayment: order.paymentMethod,
          lastOrderDate: order.orderDate,
          salesStatus: "Sales Done",
          agentAssigned: order.agentName,
          agentsRemarks: order.selfRemark || "",
          myOrderData: {
            orderDate: order.orderDate,
            productOrdered: order.productOrdered,
            dosageOrdered: order.dosageOrdered,
            totalPrice: order.totalPrice,
            paymentMethod: order.paymentMethod,
            partialPayment: order.partialPayment,
            selfRemark: order.selfRemark,
            orderId: order.orderId || "",
            shipmentStatus: "",
          },
        });
      }
    });

    // 5. Sort merged data by latest order date
    merged.sort((a, b) => {
      const aDate = new Date(a.myOrderData?.orderDate || a.lastOrderDate || 0);
      const bDate = new Date(b.myOrderData?.orderDate || b.lastOrderDate || 0);
      return bDate - aDate; // descending order
    });

    // 6. Paginate
    const paginated = merged.slice(skip, skip + parseInt(limit));
    res.json({ sales: paginated, totalSales: merged.length });
  } catch (error) {
    console.error("Error in merged-sales API:", error);
    res.status(500).json({ error: "Failed to fetch merged sales" });
  }
});

// Utility: Validate MongoDB ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// PUT update for either Lead or MyOrder
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }

  try {
    const existingLead = await Lead.findById(id);
    if (existingLead) {
      const updated = await Lead.findByIdAndUpdate(id, updates, { new: true });
      return res.status(200).json({ source: "lead", updated });
    }

    const existingOrder = await MyOrder.findById(id);
    if (existingOrder) {
      const updated = await MyOrder.findByIdAndUpdate(id, updates, { new: true });
      return res.status(200).json({ source: "order", updated });
    }

    return res.status(404).json({ message: "Record not found in Lead or MyOrder" });
  } catch (err) {
    console.error("Error updating merged sale:", err);
    return res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

module.exports = router;
