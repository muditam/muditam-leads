// routes/combinedOrders.js
const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const MyOrder = require("../models/MyOrder");
const Employee = require("../models/Employee");
const Order = require("../models/Order");


// =====================
// /sales-metrics endpoint
// =====================
router.get('/sales-metrics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const sDate = startDate ? new Date(startDate) : new Date('2000-01-01');
    const eDate = endDate ? new Date(endDate) : new Date();
    eDate.setHours(23, 59, 59, 999);


    const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName"); 
    const salesAgentNames = salesAgents.map(agent => agent.fullName);


    const orderIds = await MyOrder.distinct("orderId", {
      orderDate: { $gte: sDate, $lte: eDate },
      agentName: { $in: salesAgentNames }
    });


    const orders = await MyOrder.find({
      orderId: { $in: orderIds },
      orderDate: { $gte: sDate, $lte: eDate },
      agentName: { $in: salesAgentNames }
    }).lean();


    const uniqueOrdersMap = {};
    orders.forEach(order => {
      const key = order.orderId;
      if (!uniqueOrdersMap[key]) {
        uniqueOrdersMap[key] = order;
      }
    });
    const uniqueOrders = Object.values(uniqueOrdersMap);


    const salesDone = uniqueOrders.length;
    const totalSales = uniqueOrders.reduce((sum, order) => {
      return sum + (Number(order.totalPrice) || Number(order.amountPaid) || 0);
    }, 0);
    const avgOrderValue = salesDone > 0 ? Number((totalSales / salesDone).toFixed(2)) : 0;


    res.json({ salesDone, totalSales, avgOrderValue });
  } catch (error) {
    console.error("Error fetching sales metrics:", error);
    res.status(500).json({ message: "Error fetching sales metrics", error: error.message });
  }
});


// =====================
// GET Combined Orders Endpoint
// =====================
// router.get("/", async (req, res) => {
//   try {
//     const { page = 1, limit = 30, ...filters } = req.query;
//     const pageNumber = parseInt(page, 10) || 1;
//     const limitNumber = parseInt(limit, 10) || 30;
//     const skip = (pageNumber - 1) * limitNumber;

//     const leadMatch = {
//       salesStatus: "Sales Done",
//       agentAssigned: { $nin: ["Admin", "Online Order"] },
//     };
//     if (filters.name) leadMatch.name = { $regex: filters.name, $options: "i" };
//     if (filters.contactNumber) leadMatch.contactNumber = { $regex: filters.contactNumber, $options: "i" };
//     if (filters.agentName) {
//       const arr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
//       leadMatch.agentAssigned = { $in: arr };
//     }
//     if (filters.healthExpertAssigned) {
//       if (filters.healthExpertAssigned === "blank") {
//         leadMatch.$or = [
//           { healthExpertAssigned: { $exists: false } },
//           { healthExpertAssigned: "" },
//           { healthExpertAssigned: { $regex: /^\s*$/ } },
//         ];
//       } else {
//         leadMatch.healthExpertAssigned = { $regex: filters.healthExpertAssigned, $options: "i" };
//       }
//     }
//     if (filters.modeOfPayment) {
//       const arr = Array.isArray(filters.modeOfPayment) ? filters.modeOfPayment : [filters.modeOfPayment];
//       leadMatch.modeOfPayment = { $in: arr };
//     }
//     if (filters.productsOrdered) {
//       const arr = Array.isArray(filters.productsOrdered) ? filters.productsOrdered : [filters.productsOrdered];
//       leadMatch.productsOrdered = { $in: arr };
//     }
//     if (filters.startDate) {
//       leadMatch.lastOrderDate = leadMatch.lastOrderDate || {};
//       leadMatch.lastOrderDate.$gte = new Date(filters.startDate);
//     }
//     if (filters.endDate) {
//       leadMatch.lastOrderDate = leadMatch.lastOrderDate || {};
//       leadMatch.lastOrderDate.$lte = new Date(filters.endDate);
//     }
//     if (filters.orderDate) {
//       const start = new Date(filters.orderDate);
//       const end = new Date(filters.orderDate);
//       end.setDate(end.getDate() + 1);
//       leadMatch.lastOrderDate = { $gte: start, $lt: end };
//     }

//     const myOrderMatch = {};
//     if (filters.name) myOrderMatch.customerName = { $regex: filters.name, $options: "i" };
//     if (filters.contactNumber) myOrderMatch.phone = { $regex: filters.contactNumber, $options: "i" };
//     if (filters.agentName) {
//       const arr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
//       myOrderMatch.agentName = { $in: arr };
//     }
//     if (filters.modeOfPayment) {
//       const arr = Array.isArray(filters.modeOfPayment) ? filters.modeOfPayment : [filters.modeOfPayment];
//       myOrderMatch.paymentMethod = { $in: arr };
//     }
//     if (filters.productsOrdered) {
//       const arr = Array.isArray(filters.productsOrdered) ? filters.productsOrdered : [filters.productsOrdered];
//       myOrderMatch.productOrdered = { $in: arr };
//     }
//     if (filters.startDate) {
//       myOrderMatch.orderDate = myOrderMatch.orderDate || {};
//       myOrderMatch.orderDate.$gte = new Date(filters.startDate);
//     }
//     if (filters.endDate) {
//       myOrderMatch.orderDate = myOrderMatch.orderDate || {};
//       myOrderMatch.orderDate.$lte = new Date(filters.endDate);
//     }
//     if (filters.orderDate) {
//       const start = new Date(filters.orderDate);
//       const end = new Date(filters.orderDate);
//       end.setDate(end.getDate() + 1);
//       myOrderMatch.orderDate = { $gte: start, $lt: end };
//     }

//     const leadPipeline = [
//       { $match: leadMatch },
//       { $addFields: { isLead: 1 } },
//       {
//         $project: {
//           orderDate: "$lastOrderDate",
//           name: "$name",
//           contactNumber: "$contactNumber",
//           agentName: "$agentAssigned",
//           productsOrdered: "$productsOrdered",
//           dosageOrdered: "$dosageOrdered",
//           healthExpertAssigned: "$healthExpertAssigned",
//           remarkForHE: "$agentsRemarks",
//           amountPaid: "$amountPaid",
//           modeOfPayment: "$modeOfPayment",
//           isLead: 1,
//           shipment_status: "N/A"
//         },
//       },
//     ];

//     const myOrderPipeline = [
//       { $match: myOrderMatch },
//       {
//         $lookup: {
//           from: "employees",
//           localField: "agentName",
//           foreignField: "fullName",
//           as: "employeeData",
//         },
//       },
//       {
//         $match: {
//           employeeData: { $elemMatch: { role: "Sales Agent" } },
//         },
//       },
//       {
//         $lookup: {
//           from: "leads",
//           localField: "phone",
//           foreignField: "contactNumber",
//           as: "leadData",
//         },
//       },
//       {
//         $addFields: {
//           healthExpertAssigned: {
//             $ifNull: [
//               {
//                 $arrayElemAt: [
//                   {
//                     $map: {
//                       input: "$leadData",
//                       as: "ld",
//                       in: "$$ld.healthExpertAssigned",
//                     },
//                   },
//                   0,
//                 ],
//               },
//               "$healthExpertAssigned",
//             ],
//           },
//         },
//       },
//       {
//         $addFields: {
//           cleanedOrderId: { $trim: { input: { $substrCP: ["$orderId", 1, { $strLenCP: "$orderId" }] } } }
//         }
//       },
//       {
//         $lookup: {
//           from: "orders",
//           let: { cleanId: "$cleanedOrderId" },
//           pipeline: [
//             {
//               $addFields: {
//                 order_id_cleaned: { $trim: { input: "$order_id" } }
//               }
//             },
//             {
//               $match: {
//                 $expr: {
//                   $eq: [
//                     { $toLower: "$order_id_cleaned" },
//                     { $toLower: "$$cleanId" }
//                   ]
//                 }
//               }
//             }
//           ],
//           as: "shipmentData"
//         }
//       },
//       {
//         $addFields: {
//           shipment_status: {
//             $ifNull: [
//               {
//                 $arrayElemAt: [
//                   {
//                     $map: {
//                       input: "$shipmentData",
//                       as: "sd",
//                       in: "$$sd.shipment_status"
//                     }
//                   },
//                   0
//                 ]
//               },
//               "Not Available",
//             ],
//           },
//         },
//       },
//       { $addFields: { isLead: 0 } },
//       {
//         $project: {
//           orderDate: "$orderDate",
//           name: "$customerName",
//           contactNumber: "$phone",
//           agentName: "$agentName",
//           productsOrdered: "$productOrdered",
//           dosageOrdered: "$dosageOrdered",
//           healthExpertAssigned: 1,
//           remarkForHE: "$selfRemark",
//           amountPaid: "$totalPrice",
//           modeOfPayment: "$paymentMethod",
//           isLead: "$isLead",
//           shipment_status: 1,
//         },
//       },
//     ];

//     const unionPipeline = [
//       ...leadPipeline,
//       { $unionWith: { coll: "myorders", pipeline: myOrderPipeline } },
//     ];

//     const sortStage = { $sort: { isLead: -1, orderDate: -1 } };
//     const groupStage = {
//       $group: {
//         _id: {
//           contactNumber: "$contactNumber",
//           orderDate: "$orderDate",
//           name: "$name",
//         },
//         orderDate: { $first: "$orderDate" },
//         name: { $first: "$name" },
//         contactNumber: { $first: "$contactNumber" },
//         agentName: { $first: "$agentName" },
//         productsOrdered: { $first: "$productsOrdered" },
//         dosageOrdered: { $first: "$dosageOrdered" },
//         healthExpertAssigned: { $first: "$healthExpertAssigned" },
//         remarkForHE: { $first: "$remarkForHE" },
//         amountPaid: { $first: "$amountPaid" },
//         modeOfPayment: { $first: "$modeOfPayment" },
//         isLead: { $first: "$isLead" },
//         shipment_status: { $first: "$shipment_status" },
//       },
//     };

//     const finalSort = { $sort: { orderDate: -1 } };
//     const facetStage = {
//       $facet: {
//         data: [{ $skip: skip }, { $limit: limitNumber }],
//         totalCount: [{ $count: "total" }],
//       },
//     };

//     const aggregationPipeline = [
//       ...unionPipeline,
//       sortStage,
//       groupStage,
//       finalSort,
//       facetStage,
//     ];

//     const results = await Lead.aggregate(aggregationPipeline);
//     const combinedData = results[0].data;
//     const totalCount = results[0].totalCount[0] ? results[0].totalCount[0].total : 0;
//     const totalPages = Math.ceil(totalCount / limitNumber);

//     res.status(200).json({
//       orders: combinedData,
//       total: totalCount,
//       page: pageNumber,
//       limit: limitNumber,
//       totalPages,
//     });
//   } catch (error) {
//     console.error("Error fetching combined orders:", error);
//     res.status(500).json({ message: "Error fetching combined orders", error: error.message });
//   }
// });

router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 30, ...filters } = req.query;
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 30;
    const skip = (pageNumber - 1) * limitNumber;

    // ========= FILTER PREP =========
    const leadMatch = {
      salesStatus: "Sales Done",
      agentAssigned: { $nin: ["Admin", "Online Order"] }, 
    };
    const myOrderMatch = {};

    if (filters.name) {
      leadMatch.name = { $regex: filters.name, $options: "i" };
      myOrderMatch.customerName = { $regex: filters.name, $options: "i" };
    }
    if (filters.contactNumber) {
      leadMatch.contactNumber = { $regex: filters.contactNumber, $options: "i" };
      myOrderMatch.phone = { $regex: filters.contactNumber, $options: "i" };
    }
    if (filters.agentName) {
      const agentArr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
      leadMatch.agentAssigned = { $in: agentArr };
      myOrderMatch.agentName = { $in: agentArr };
    }
    if (filters.modeOfPayment) {
      const modeArr = Array.isArray(filters.modeOfPayment) ? filters.modeOfPayment : [filters.modeOfPayment];
      leadMatch.modeOfPayment = { $in: modeArr };
      myOrderMatch.paymentMethod = { $in: modeArr };
    }
    if (filters.productsOrdered) {
      const productArr = Array.isArray(filters.productsOrdered) ? filters.productsOrdered : [filters.productsOrdered];
      leadMatch.productsOrdered = { $in: productArr };
      myOrderMatch.productOrdered = { $in: productArr };
    }
    if (filters.startDate) {
      leadMatch.lastOrderDate = { ...leadMatch.lastOrderDate, $gte: new Date(filters.startDate) };
      myOrderMatch.orderDate = { ...myOrderMatch.orderDate, $gte: new Date(filters.startDate) };
    }
    if (filters.endDate) {
      leadMatch.lastOrderDate = { ...leadMatch.lastOrderDate, $lte: new Date(filters.endDate) };
      myOrderMatch.orderDate = { ...myOrderMatch.orderDate, $lte: new Date(filters.endDate) };
    }
    if (filters.orderDate) {
      const start = new Date(filters.orderDate);
      const end = new Date(filters.orderDate);
      end.setDate(end.getDate() + 1);
      leadMatch.lastOrderDate = { $gte: start, $lt: end };
      myOrderMatch.orderDate = { $gte: start, $lt: end };
    }
    if (filters.healthExpertAssigned) {
      if (filters.healthExpertAssigned === "blank") {
        leadMatch.$or = [
          { healthExpertAssigned: { $exists: false } },
          { healthExpertAssigned: "" },
          { healthExpertAssigned: { $regex: /^\s*$/ } },
        ];
      } else {
        leadMatch.healthExpertAssigned = { $regex: filters.healthExpertAssigned, $options: "i" };
      }
    }
    if (filters.healthExpertAssigned) {
  if (filters.healthExpertAssigned === "blank") {
    myOrderMatch.$or = [
      { healthExpertAssigned: { $exists: false } },
      { healthExpertAssigned: "" },
      { healthExpertAssigned: { $regex: /^\s*$/ } },
    ];
  } else {
    myOrderMatch.healthExpertAssigned = {
      $regex: filters.healthExpertAssigned,
      $options: "i",
    };
  }
}


    // ========= FETCH LEADS =========
    const leads = await Lead.find(leadMatch).sort({ lastOrderDate: -1 }).lean();
    const formattedLeads = leads.map(lead => ({
      orderDate: lead.lastOrderDate,
      name: lead.name,
      contactNumber: lead.contactNumber,
      agentName: lead.agentAssigned,
      productsOrdered: lead.productsOrdered,
      dosageOrdered: lead.dosageOrdered,
      healthExpertAssigned: lead.healthExpertAssigned || "",
      remarkForHE: lead.agentsRemarks || "",
      amountPaid: lead.amountPaid || "",
      modeOfPayment: lead.modeOfPayment || "",
      shipment_status: "N/A",
      isLead: 1,
    }));

    // ========= FETCH MYORDERS =========
    const myOrders = await MyOrder.find(myOrderMatch).sort({ orderDate: -1 }).lean();

    // ===== Map health experts from leads (for MyOrders) =====
    const phoneSet = new Set(myOrders.map(m => m.phone));
    const leadsForMyOrder = await Lead.find({ contactNumber: { $in: Array.from(phoneSet) } }, "contactNumber healthExpertAssigned").lean();
    const healthMap = {};
    leadsForMyOrder.forEach(lead => {
      healthMap[lead.contactNumber] = lead.healthExpertAssigned;
    });

    // ===== Normalize orderId for shipment match =====
    const normalize = (id) =>
      id?.toString().replace(/[^a-zA-Z0-9]/g, "").trim().toLowerCase();

    const orderIdList = myOrders.map(o => normalize(o.orderId)).filter(Boolean);
    const shipmentData = await Order.find(
  { order_id: { $in: orderIdList } },
  "order_id shipment_status"
).lean();

    const shipmentMap = {};
    shipmentData.forEach(order => {
      const cleaned = normalize(order.order_id);
      if (cleaned) {
        shipmentMap[cleaned] = order.shipment_status;
      }
    });

    let missingCount = 0;

    const formattedMyOrders = myOrders.map(order => {
      const cleanedId = normalize(order.orderId);
      let shipment_status = shipmentMap[cleanedId];

      if (!shipment_status) {
    const fallback = Object.entries(shipmentMap).find(([key]) =>
      key.includes(cleanedId) || cleanedId.includes(key)
    );
    shipment_status = fallback?.[1] || "Not Available";
  }4

      return {
        orderDate: order.orderDate,
        name: order.customerName,
        contactNumber: order.phone,
        agentName: order.agentName,
        productsOrdered: order.productOrdered,
        dosageOrdered: order.dosageOrdered,
        healthExpertAssigned: healthMap[order.phone] || order.healthExpertAssigned || "",
        remarkForHE: order.selfRemark || "",
        amountPaid: order.totalPrice || "",
        modeOfPayment: order.paymentMethod || "",
        shipment_status,
        isLead: 0,
      };
    });

    // ========= COMBINE + SORT + PAGINATE =========
    const combined = [...formattedLeads, ...formattedMyOrders];
    const deduplicated = [];

    const seen = new Set();
    for (const entry of combined) {
      const date = new Date(entry.orderDate);
      if (isNaN(date.getTime())) continue;
      const key = `${entry.contactNumber}_${date.toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(entry);
      }
    }

    deduplicated.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    const paginated = deduplicated.slice(skip, skip + limitNumber);

    res.json({
      orders: paginated,
      total: deduplicated.length,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(deduplicated.length / limitNumber),
    });
  } catch (error) {
    console.error("Error fetching combined orders:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
});


// =====================
// PUT /update-by-contact endpoint
// =====================
router.put("/update-by-contact", async (req, res) => {
  const { contactNumber, healthExpertAssigned } = req.body;
  if (!contactNumber) {
    return res.status(400).json({ message: "contactNumber is required." });
  }
  try {
    // Update all Lead documents matching the contactNumber
    const leadResult = await Lead.updateMany(
      { contactNumber },
      { $set: { healthExpertAssigned } }
    );
    // Update all MyOrder documents matching the phone number
    const orderResult = await MyOrder.updateMany(
      { phone: contactNumber },
      { $set: { healthExpertAssigned } },
      { strict: false }
    );
    // Optionally, fetch updated records to return
    const updatedLeads = await Lead.find({ contactNumber });
    const updatedOrders = await MyOrder.find({ phone: contactNumber });
    console.log("updated orders", updatedOrders)
    if (updatedLeads.length === 0 && updatedOrders.length === 0) {
      return res.status(404).json({ message: "No record found with the provided contact number." });  
    }
    res.status(200).json({ updatedLead: updatedLeads, updatedMyOrder: updatedOrders });
  } catch (error) {
    console.error("Error updating record:", error);
    res.status(500).json({ message: "Error updating record.", error: error.message });
  }
});


module.exports = router;



