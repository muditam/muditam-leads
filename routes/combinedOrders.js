// routes/combinedOrders.js
const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const MyOrder = require("../models/MyOrder");
const Employee = require("../models/Employee");

router.get('/sales-metrics', async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      // Set default date range if not provided
      const sDate = startDate ? new Date(startDate) : new Date('2000-01-01');
      const eDate = endDate ? new Date(endDate) : new Date();
      eDate.setHours(23, 59, 59, 999);
  
      // Get list of Sales Agents
      const salesAgents = await Employee.find({ role: "Sales Agent" }, "fullName");
      const salesAgentNames = salesAgents.map(agent => agent.fullName);
  
      // Get distinct order IDs from MyOrder for the date range and sales agents
      const orderIds = await MyOrder.distinct("orderId", {
        orderDate: { $gte: sDate, $lte: eDate },
        agentName: { $in: salesAgentNames }
      });
  
      // Fetch orders from MyOrder whose orderId is in the distinct list
      const orders = await MyOrder.find({
        orderId: { $in: orderIds },
        orderDate: { $gte: sDate, $lte: eDate },
        agentName: { $in: salesAgentNames }
      }).lean();
  
      // Deduplicate orders by orderId
      const uniqueOrdersMap = {};
      orders.forEach(order => {
        const key = order.orderId;
        if (!uniqueOrdersMap[key]) {
          uniqueOrdersMap[key] = order;
        }
      });
      const uniqueOrders = Object.values(uniqueOrdersMap);
  
      // Sales Done is the count of distinct orders
      const salesDone = uniqueOrders.length;
      // Sum up the totalSales using the totalPrice field (or fallback to amountPaid)
      const totalSales = uniqueOrders.reduce((sum, order) => {
        return sum + (Number(order.totalPrice) || Number(order.amountPaid) || 0);
      }, 0);
      // Calculate average order value rounded to 2 decimal places
      const avgOrderValue = salesDone > 0 ? Number((totalSales / salesDone).toFixed(2)) : 0;
  
      res.json({ salesDone, totalSales, avgOrderValue });
    } catch (error) {
      console.error("Error fetching sales metrics:", error);
      res.status(500).json({ message: "Error fetching sales metrics", error: error.message });
    }
  });

   
  
router.get("/", async (req, res) => {
    try {
      const { page = 1, limit = 30, ...filters } = req.query;
      const pageNumber = parseInt(page, 10) || 1;
      const limitNumber = parseInt(limit, 10) || 30;
      const skip = (pageNumber - 1) * limitNumber;
  
      // -------------------------------
      // Build filters for Lead collection
      // -------------------------------
      const leadMatch = {  
        salesStatus: "Sales Done",
        agentAssigned: { $nin: ['Admin', 'Online Order'] }
      };
      if (filters.name) {
        leadMatch.name = { $regex: filters.name, $options: "i" };
      }
      if (filters.contactNumber) {
        leadMatch.contactNumber = { $regex: filters.contactNumber, $options: "i" };
      }
      if (filters.agentName) {
        const arr = Array.isArray(filters.agentName) ? filters.agentName : [filters.agentName];
        leadMatch.agentAssigned = { $in: arr };
      }
      if (filters.healthExpertAssigned) {
        if (filters.healthExpertAssigned === "blank") {
          leadMatch.$or = [
            { healthExpertAssigned: { $exists: false } },
            { healthExpertAssigned: "" },
            { healthExpertAssigned: { $regex: /^\s*$/ } }
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
  
      // -------------------------------
      // Build filters for MyOrder collection
      // -------------------------------
      const myOrderMatch = {};
      if (filters.name) {
        myOrderMatch.customerName = { $regex: filters.name, $options: "i" };
      }
      if (filters.contactNumber) {
        myOrderMatch.phone = { $regex: filters.contactNumber, $options: "i" };
      }
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
  
      // -------------------------------
      // Aggregation pipeline for Lead collection
      // -------------------------------
      const leadPipeline = [
        { $match: leadMatch },
        { $addFields: { isLead: 1 } },
        { $project: {
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
            isLead: 1
        } }
      ];
  
      // -------------------------------
      // Aggregation pipeline for MyOrder collection
      // -------------------------------
      const myOrderPipeline = [
        { $match: myOrderMatch },
        {
           $lookup: {
               from: "employees",
               localField: "agentName",
               foreignField: "fullName",
               as: "employeeData"
           }
        },
        { 
          $match: {
            employeeData: { $elemMatch: { role: "Sales Agent" } }
          }
        },
        { $addFields: { isLead: 0 } },
        { $project: {
            orderDate: "$orderDate",
            name: "$customerName",
            contactNumber: "$phone",
            agentName: "$agentName",
            productsOrdered: "$productOrdered",
            dosageOrdered: "$dosageOrdered",
            healthExpertAssigned: { $ifNull: ["$healthExpertAssigned", ""] },
            remarkForHE: "$selfRemark",
            amountPaid: "$totalPrice",
            modeOfPayment: "$paymentMethod",
            isLead: "$isLead"
        } }
      ];
  
      // -------------------------------
      // Combine both pipelines using $unionWith
      // -------------------------------
      const unionPipeline = [
        ...leadPipeline,
        { $unionWith: { coll: "myorders", pipeline: myOrderPipeline } }
      ];
  
      // -------------------------------
      // Sort so that Lead records (isLead:1) come before MyOrder records, then group.
      // -------------------------------
      const sortStage = { $sort: { isLead: -1, orderDate: -1 } };
  
      const groupStage = {
        $group: {
          _id: { contactNumber: "$contactNumber", orderDate: "$orderDate", name: "$name" },
          orderDate: { $first: "$orderDate" },
          name: { $first: "$name" },
          contactNumber: { $first: "$contactNumber" },
          agentName: { $first: "$agentName" },
          productsOrdered: { $first: "$productsOrdered" },
          dosageOrdered: { $first: "$dosageOrdered" },
          // Using $first here ensures that if a Lead document exists, its value is used.
          healthExpertAssigned: { $first: "$healthExpertAssigned" },
          remarkForHE: { $first: "$remarkForHE" },
          amountPaid: { $first: "$amountPaid" },
          modeOfPayment: { $first: "$modeOfPayment" },
          isLead: { $first: "$isLead" }
        }
      };
  
      // -------------------------------
      // Final sorting and pagination inside a $facet stage
      // -------------------------------
      const finalSort = { $sort: { orderDate: -1 } };
      const facetStage = {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNumber }],
          totalCount: [{ $count: "total" }]
        }
      };
  
      const aggregationPipeline = [
        ...unionPipeline,
        sortStage,
        groupStage,
        finalSort,
        facetStage
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
        totalPages
      });
    } catch (error) {
      console.error("Error fetching combined orders:", error);
      res.status(500).json({ message: "Error fetching combined orders", error: error.message });
    }
  });

// In your update-by-contact route
router.put("/update-by-contact", async (req, res) => {
    const { contactNumber, healthExpertAssigned } = req.body;
    if (!contactNumber) {
      return res.status(400).json({ message: "contactNumber is required." });
    }
    try {
      // Update Lead document
      const updatedLead = await Lead.findOneAndUpdate(
        { contactNumber },
        { healthExpertAssigned },
        { new: true }
      );
      // Also update the MyOrder document based on the phone number
      const updatedMyOrder = await MyOrder.findOneAndUpdate(
        { phone: contactNumber },
        { healthExpertAssigned },
        { new: true }
      );
      if (!updatedLead && !updatedMyOrder) {
        return res.status(404).json({ message: "No record found with the provided contact number." });
      }
      res.status(200).json({ updatedLead, updatedMyOrder });
    } catch (error) {
      res.status(500).json({ message: "Error updating record.", error: error.message });
    }
  });
  
  

module.exports = router;
