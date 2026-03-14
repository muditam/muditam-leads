// const mongoose = require("mongoose");
// const express = require("express");
// const router = express.Router();
// const Lead = require("../models/Lead");
// const Customer = require("../models/Customer");
// const MyOrder = require("../models/MyOrder");


// // Normalize phone to last 10 digits
// const normalizePhone = (p) => {
//   const digits = String(p || "").replace(/\D/g, "");
//   return digits.length > 10 ? digits.slice(-10) : digits;
// };


// router.get("/", async (req, res) => {
//   const { agentAssignedName, page = 1, limit = 50 } = req.query;
//   const skip = (parseInt(page) - 1) * parseInt(limit);

//   try {
//     // 1) Leads → Same logic
//     const leadQuery = { salesStatus: "Sales Done" };
//     if (agentAssignedName) leadQuery.agentAssigned = agentAssignedName;

//     const leads = await Lead.find(leadQuery)
//       .lean()
//       .select("-images -followUps -details"); // improves speed harmlessly

//     // 2) MyOrder query → same but optimized
//     const orderQuery = {};
//     if (agentAssignedName) {
//       orderQuery.agentName = { $regex: new RegExp(agentAssignedName, "i") };
//     }

//     const allMyOrders = await MyOrder.find(orderQuery)
//       .lean()
//       .select(
//         "customerName phone orderId productOrdered dosageOrdered orderDate agentName totalPrice paymentMethod selfRemark partialPayment shipmentStatus"
//       );

//     // 3) Group orders by normalized phone
//     const ordersByPhone = Object.create(null);

//     for (const order of allMyOrders) {
//       const phone = normalizePhone(order.phone);
//       if (!ordersByPhone[phone]) ordersByPhone[phone] = [];
//       ordersByPhone[phone].push(order);
//     }

//     // Sort order list for each phone
//     for (const list of Object.values(ordersByPhone)) {
//       list.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
//     }

//     const merged = [];
//     const seenOrderIds = new Set();
//     const seenPhones = new Set();

//     // 4) Lead → Order merging (same, just faster)
//     for (const lead of leads) {
//       const phone = normalizePhone(lead.contactNumber);
//       seenPhones.add(phone);

//       const orders = ordersByPhone[phone] || [];

//       if (orders.length === 0) {
//         // no order → push pure lead (same as your logic)
//         merged.push({
//           _id: lead._id,
//           name: lead.name || "",
//           contactNumber: lead.contactNumber || "",
//           productsOrdered: lead.productsOrdered || [],
//           dosageOrdered: lead.dosageOrdered || "",
//           amountPaid: lead.amountPaid ?? "",
//           partialPayment: lead.partialPayment ?? 0,
//           modeOfPayment: lead.modeOfPayment || "",
//           lastOrderDate: lead.lastOrderDate || "",
//           salesStatus: lead.salesStatus || "Sales Done",
//           agentAssigned: lead.agentAssigned || "",
//           agentsRemarks: lead.agentsRemarks || "",
//           shipmentStatus: lead.shipmentStatus || "",
//           myOrderData: null,
//         });
//         continue;
//       }

//       // lead has multiple orders → multiple rows
//       for (const order of orders) {
//         seenOrderIds.add(String(order._id));

//         merged.push({
//           _id: lead._id,
//           name: lead.name || order.customerName,
//           contactNumber: lead.contactNumber || order.phone,
//           productsOrdered:
//             lead.productsOrdered ||
//             (order.productOrdered ? [order.productOrdered] : []),
//           dosageOrdered: lead.dosageOrdered || order.dosageOrdered,
//           amountPaid: lead.amountPaid ?? order.totalPrice,
//           partialPayment: lead.partialPayment ?? order.partialPayment ?? 0,
//           modeOfPayment: lead.modeOfPayment || order.paymentMethod,
//           lastOrderDate: lead.lastOrderDate || order.orderDate,
//           salesStatus: lead.salesStatus || "Sales Done",
//           agentAssigned: lead.agentAssigned || order.agentName || "",
//           agentsRemarks: lead.agentsRemarks || order.selfRemark || "",
//           shipmentStatus: lead.shipmentStatus || order.shipmentStatus || "",

//           myOrderData: {
//             _id: order._id,
//             orderDate: order.orderDate || "",
//             productOrdered: order.productOrdered || "",
//             dosageOrdered: order.dosageOrdered || "",
//             totalPrice: order.totalPrice ?? "",
//             paymentMethod: order.paymentMethod || "",
//             partialPayment: order.partialPayment ?? 0,
//             selfRemark: order.selfRemark || "",
//             orderId: order.orderId || "",
//             shipmentStatus: order.shipmentStatus || "",
//           },
//         });
//       }
//     }

//     // 5) Orders without leads → SAME as original
//     for (const order of allMyOrders) {
//       const phone = normalizePhone(order.phone);

//       if (seenOrderIds.has(String(order._id))) continue;
//       if (seenPhones.has(phone)) continue;

//       merged.push({
//         _id: order._id,
//         name: order.customerName || "",
//         contactNumber: order.phone || "",
//         productsOrdered: [order.productOrdered].filter(Boolean),
//         dosageOrdered: order.dosageOrdered || "",
//         amountPaid: order.totalPrice ?? "",
//         partialPayment: order.partialPayment ?? 0,
//         modeOfPayment: order.paymentMethod || "",
//         lastOrderDate: order.orderDate || "",
//         salesStatus: "Sales Done",
//         agentAssigned: order.agentName || "",
//         agentsRemarks: order.selfRemark || "",
//         shipmentStatus: order.shipmentStatus || "",
//         myOrderData: {
//           _id: order._id,
//           orderDate: order.orderDate || "",
//           productOrdered: order.productOrdered || "",
//           dosageOrdered: order.dosageOrdered || "",
//           totalPrice: order.totalPrice ?? "",
//           paymentMethod: order.paymentMethod || "",
//           partialPayment: order.partialPayment ?? 0,
//           selfRemark: order.selfRemark || "",
//           orderId: order.orderId || "",
//           shipmentStatus: order.shipmentStatus || "",
//         },
//       });
//     }

//     // 6) Sort final list (same logic)
//     merged.sort((a, b) => {
//       const aDate = new Date(a.myOrderData?.orderDate || a.lastOrderDate || 0);
//       const bDate = new Date(b.myOrderData?.orderDate || b.lastOrderDate || 0);
//       return bDate - aDate;
//     });

//     // 7) Paginate AFTER merging (same functionality)
//     const paginated = merged.slice(skip, skip + parseInt(limit));

//     res.json({
//       sales: paginated,
//       totalSales: merged.length,
//     });
//   } catch (error) {
//     console.error("Optimized merged-sales API:", error);
//     res.status(500).json({ error: "Failed to fetch merged sales" });
//   }
// });


// // Utility: Validate MongoDB ObjectId
// const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);


// // PUT update for either Lead or MyOrder (auto-detect by id)
// router.put("/:id", async (req, res) => {
//   const { id } = req.params;
//   const updates = req.body;


//   if (!isValidObjectId(id)) {
//     return res.status(400).json({ message: "Invalid ID" });
//   }


//   try {
//     const existingLead = await Lead.findById(id);
//     if (existingLead) {
//       const updated = await Lead.findByIdAndUpdate(id, updates, { new: true });
//       return res.status(200).json({ source: "lead", updated });
//     }


//     const existingOrder = await MyOrder.findById(id);
//     if (existingOrder) {
//       const updated = await MyOrder.findByIdAndUpdate(id, updates, { new: true });
//       return res.status(200).json({ source: "order", updated });


      
//     }


//     return res.status(404).json({ message: "Record not found in Lead or MyOrder" });
//   } catch (err) {
//     console.error("Error updating merged sale:", err);
//     return res.status(500).json({ message: "Internal server error", error: err.message });
//   }
// });


// module.exports = router;

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

// Escape regex special chars
const escapeRegex = (str = "") =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", async (req, res) => {
  const { agentAssignedName, page = 1, limit = 50 } = req.query;
  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 50;
  const skip = (parsedPage - 1) * parsedLimit;

  try {
    // 1) Leads query
    const leadQuery = { salesStatus: "Sales Done" };
    if (agentAssignedName) {
      leadQuery.agentAssigned = agentAssignedName;
    }

    const leads = await Lead.find(leadQuery)
      .lean()
      .select("-images -followUps -details");

    // 2) MyOrder query
    // FIX: exact case-insensitive match so "Karan" does not match "Karan S"
    const orderQuery = {};
    if (agentAssignedName) {
      orderQuery.agentName = {
        $regex: new RegExp(
          `^\\s*${escapeRegex(agentAssignedName.trim())}\\s*$`,
          "i"
        ),
      };
    }

    const allMyOrders = await MyOrder.find(orderQuery)
      .lean()
      .select(
        "customerName phone orderId productOrdered dosageOrdered orderDate agentName totalPrice paymentMethod selfRemark partialPayment shipmentStatus"
      );

    // 3) Group orders by normalized phone
    const ordersByPhone = Object.create(null);

    for (const order of allMyOrders) {
      const phone = normalizePhone(order.phone);
      if (!phone) continue;

      if (!ordersByPhone[phone]) ordersByPhone[phone] = [];
      ordersByPhone[phone].push(order);
    }

    // Sort orders for each phone by latest orderDate first
    for (const list of Object.values(ordersByPhone)) {
      list.sort((a, b) => {
        const aDate = new Date(a.orderDate || 0);
        const bDate = new Date(b.orderDate || 0);
        return bDate - aDate;
      });
    }

    const merged = [];
    const seenOrderIds = new Set();
    const seenPhones = new Set();

    // 4) Merge leads with orders
    for (const lead of leads) {
      const phone = normalizePhone(lead.contactNumber);
      if (phone) seenPhones.add(phone);

      const orders = phone ? ordersByPhone[phone] || [] : [];

      if (orders.length === 0) {
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
        continue;
      }

      for (const order of orders) {
        seenOrderIds.add(String(order._id));

        merged.push({
          _id: lead._id,
          name: lead.name || order.customerName || "",
          contactNumber: lead.contactNumber || order.phone || "",
          productsOrdered:
            Array.isArray(lead.productsOrdered) && lead.productsOrdered.length
              ? lead.productsOrdered
              : order.productOrdered
              ? [order.productOrdered]
              : [],
          dosageOrdered: lead.dosageOrdered || order.dosageOrdered || "",
          amountPaid: lead.amountPaid ?? order.totalPrice ?? "",
          partialPayment: lead.partialPayment ?? order.partialPayment ?? 0,
          modeOfPayment: lead.modeOfPayment || order.paymentMethod || "",
          lastOrderDate: lead.lastOrderDate || order.orderDate || "",
          salesStatus: lead.salesStatus || "Sales Done",
          agentAssigned: lead.agentAssigned || order.agentName || "",
          agentsRemarks: lead.agentsRemarks || order.selfRemark || "",
          shipmentStatus: lead.shipmentStatus || order.shipmentStatus || "",
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
    }

    // 5) Orders without matching leads
    for (const order of allMyOrders) {
      const phone = normalizePhone(order.phone);

      if (seenOrderIds.has(String(order._id))) continue;
      if (phone && seenPhones.has(phone)) continue;

      merged.push({
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
        shipmentStatus: order.shipmentStatus || "",
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

    // 6) Sort final merged list
    merged.sort((a, b) => {
      const aDate = new Date(a.myOrderData?.orderDate || a.lastOrderDate || 0);
      const bDate = new Date(b.myOrderData?.orderDate || b.lastOrderDate || 0);
      return bDate - aDate;
    });

    // 7) Paginate after merge
    const paginated = merged.slice(skip, skip + parsedLimit);

    res.json({
      sales: paginated,
      totalSales: merged.length,
    });
  } catch (error) {
    console.error("Optimized merged-sales API:", error);
    res.status(500).json({ error: "Failed to fetch merged sales" });
  }
});

// Utility: Validate MongoDB ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// PUT update for either Lead or MyOrder (auto-detect by id)
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  if (!isValidObjectId(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }

  try {
    const existingLead = await Lead.findById(id);
    if (existingLead) {
      const updated = await Lead.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true,
      });
      return res.status(200).json({ source: "lead", updated });
    }

    const existingOrder = await MyOrder.findById(id);
    if (existingOrder) {
      const updated = await MyOrder.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true,
      });
      return res.status(200).json({ source: "order", updated });
    }

    return res.status(404).json({ message: "Record not found in Lead or MyOrder" });
  } catch (err) {
    console.error("Error updating merged sale:", err);
    return res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
});

module.exports = router;

