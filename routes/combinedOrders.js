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
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 30, ...filters } = req.query;
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 30;
    const skip = (pageNumber - 1) * limitNumber;

    const leadMatch = {
      salesStatus: "Sales Done",
      agentAssigned: { $nin: ["Admin", "Online Order"] },
    };
    if (filters.name) leadMatch.name = { $regex: filters.name, $options: "i" };
    if (filters.contactNumber) leadMatch.contactNumber = { $regex: filters.contactNumber, $options: "i" };
    if (filters.agentName) {
      const arr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
      leadMatch.agentAssigned = { $in: arr };
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
    if (filters.modeOfPayment) {
      const arr = Array.isArray(filters.modeOfPayment) ? filters.modeOfPayment : [filters.modeOfPayment];
      leadMatch.modeOfPayment = { $in: arr };
    }
    if (filters.productsOrdered) {
      const arr = Array.isArray(filters.productsOrdered) ? filters.productsOrdered : [filters.productsOrdered];
      leadMatch.productsOrdered = { $in: arr };
    }
    if (filters.startDate) {
      leadMatch.lastOrderDate = leadMatch.lastOrderDate || {};
      leadMatch.lastOrderDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      leadMatch.lastOrderDate = leadMatch.lastOrderDate || {};
      leadMatch.lastOrderDate.$lte = new Date(filters.endDate);
    }
    if (filters.orderDate) {
      const start = new Date(filters.orderDate);
      const end = new Date(filters.orderDate);
      end.setDate(end.getDate() + 1);
      leadMatch.lastOrderDate = { $gte: start, $lt: end };
    }

    const myOrderMatch = {};
    if (filters.name) myOrderMatch.customerName = { $regex: filters.name, $options: "i" };
    if (filters.contactNumber) myOrderMatch.phone = { $regex: filters.contactNumber, $options: "i" };
    if (filters.agentName) {
      const arr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
      myOrderMatch.agentName = { $in: arr };
    }
    if (filters.modeOfPayment) {
      const arr = Array.isArray(filters.modeOfPayment) ? filters.modeOfPayment : [filters.modeOfPayment];
      myOrderMatch.paymentMethod = { $in: arr };
    }
    if (filters.productsOrdered) {
      const arr = Array.isArray(filters.productsOrdered) ? filters.productsOrdered : [filters.productsOrdered];
      myOrderMatch.productOrdered = { $in: arr };
    }
    if (filters.startDate) {
      myOrderMatch.orderDate = myOrderMatch.orderDate || {};
      myOrderMatch.orderDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      myOrderMatch.orderDate = myOrderMatch.orderDate || {};
      myOrderMatch.orderDate.$lte = new Date(filters.endDate);
    }
    if (filters.orderDate) {
      const start = new Date(filters.orderDate);
      const end = new Date(filters.orderDate);
      end.setDate(end.getDate() + 1);
      myOrderMatch.orderDate = { $gte: start, $lt: end };
    }

    const leadPipeline = [
      { $match: leadMatch },
      { $addFields: { isLead: 1 } },
      {
        $project: {
          orderDate: "$lastOrderDate",
          name: "$name",
          contactNumber: "$contactNumber",
          agentName: "$agentAssigned",
          productsOrdered: "$productsOrdered",
          dosageOrdered: "$dosageOrdered",
          healthExpertAssigned: "$healthExpertAssigned",
          remarkForHE: "$agentsRemarks",
          amountPaid: "$amountPaid",
          modeOfPayment: "$modeOfPayment",
          isLead: 1,
          shipment_status: "N/A"
        },
      },
    ];

    const myOrderPipeline = [
      { $match: myOrderMatch },
      {
        $lookup: {
          from: "employees",
          localField: "agentName",
          foreignField: "fullName",
          as: "employeeData",
        },
      },
      {
        $match: {
          employeeData: { $elemMatch: { role: "Sales Agent" } },
        },
      },
      {
        $lookup: {
          from: "leads",
          localField: "phone",
          foreignField: "contactNumber",
          as: "leadData",
        },
      },
      {
        $addFields: {
          healthExpertAssigned: {
            $ifNull: [
              {
                $arrayElemAt: [
                  {
                    $map: {
                      input: "$leadData",
                      as: "ld",
                      in: "$$ld.healthExpertAssigned",
                    },
                  },
                  0,
                ],
              },
              "$healthExpertAssigned",
            ],
          },
        },
      },
      {
        $addFields: {
          cleanedOrderId: { $trim: { input: { $substrCP: ["$orderId", 1, { $strLenCP: "$orderId" }] } } }
        }
      },
      {
        $lookup: {
          from: "orders",
          let: { cleanId: "$cleanedOrderId" },
          pipeline: [
            {
              $addFields: {
                order_id_cleaned: { $trim: { input: "$order_id" } }
              }
            },
            {
              $match: {
                $expr: {
                  $eq: [
                    { $toLower: "$order_id_cleaned" },
                    { $toLower: "$$cleanId" }
                  ]
                }
              }
            }
          ],
          as: "shipmentData"
        }
      },
      {
        $addFields: {
          shipment_status: {
            $ifNull: [
              {
                $arrayElemAt: [
                  {
                    $map: {
                      input: "$shipmentData",
                      as: "sd",
                      in: "$$sd.shipment_status"
                    }
                  },
                  0
                ]
              },
              "Not Available",
            ],
          },
        },
      },
      { $addFields: { isLead: 0 } },
      {
        $project: {
          orderDate: "$orderDate",
          name: "$customerName",
          contactNumber: "$phone",
          agentName: "$agentName",
          productsOrdered: "$productOrdered",
          dosageOrdered: "$dosageOrdered",
          healthExpertAssigned: 1,
          remarkForHE: "$selfRemark",
          amountPaid: "$totalPrice",
          modeOfPayment: "$paymentMethod",
          isLead: "$isLead",
          shipment_status: 1,
        },
      },
    ];

    const unionPipeline = [
      ...leadPipeline,
      { $unionWith: { coll: "myorders", pipeline: myOrderPipeline } },
    ];

    const sortStage = { $sort: { isLead: -1, orderDate: -1 } };
    const groupStage = {
      $group: {
        _id: {
          contactNumber: "$contactNumber",
          orderDate: "$orderDate",
          name: "$name",
        },
        orderDate: { $first: "$orderDate" },
        name: { $first: "$name" },
        contactNumber: { $first: "$contactNumber" },
        agentName: { $first: "$agentName" },
        productsOrdered: { $first: "$productsOrdered" },
        dosageOrdered: { $first: "$dosageOrdered" },
        healthExpertAssigned: { $first: "$healthExpertAssigned" },
        remarkForHE: { $first: "$remarkForHE" },
        amountPaid: { $first: "$amountPaid" },
        modeOfPayment: { $first: "$modeOfPayment" },
        isLead: { $first: "$isLead" },
        shipment_status: { $first: "$shipment_status" },
      },
    };

    const finalSort = { $sort: { orderDate: -1 } };
    const facetStage = {
      $facet: {
        data: [{ $skip: skip }, { $limit: limitNumber }],
        totalCount: [{ $count: "total" }],
      },
    };

    const aggregationPipeline = [
      ...unionPipeline,
      sortStage,
      groupStage,
      finalSort,
      facetStage,
    ];

    const results = await Lead.aggregate(aggregationPipeline);
    const combinedData = results[0].data;
    const totalCount = results[0].totalCount[0] ? results[0].totalCount[0].total : 0;
    const totalPages = Math.ceil(totalCount / limitNumber);

    res.status(200).json({
      orders: combinedData,
      total: totalCount,
      page: pageNumber,
      limit: limitNumber,
      totalPages,
    });
  } catch (error) {
    console.error("Error fetching combined orders:", error);
    res.status(500).json({ message: "Error fetching combined orders", error: error.message });
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



