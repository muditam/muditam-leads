// routes/retentionSalesRoutes.js

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const router = express.Router();

const Lead = require('../models/Lead');

// Import the Order model (Shipway data)
const Order = require('../models/Order');
const MyOrder = require("../models/MyOrder");
const Employee = require("../models/Employee");

const RetentionSalesSchema = new mongoose.Schema({
  date: String,
  name: String,
  contactNumber: String,
  productsOrdered: [String],
  dosageOrdered: { type: String, default: "" },
  upsellAmount: { type: Number, default: 0 },  
  partialPayment: { type: Number, default: 0 },  
  amountPaid: { type: Number, default: 0 },
  modeOfPayment: String,
  orderId: String,
  shopify_amount: String,
  shipway_status: String,
  orderCreatedBy: String,
  remarks: String,
});

const RetentionSales = mongoose.model("RetentionSales", RetentionSalesSchema);
 
 
const normalizePhoneNumber = (phone) => {
  if (!phone) return "";
  let digits = phone.replace(/\D/g, "");
  // Remove leading country code "91" if present
  if (digits.length > 10 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  // Remove leading "0" if length is 11
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return digits;
};


const buildDateMatch = (startDate, endDate) => {
  const match = {};
  if (startDate) match.date = { $gte: startDate };
  if (endDate) {
    match.date = match.date ? { ...match.date, $lte: endDate } : { $lte: endDate }; 
  }
  return match;
};
 
router.get('/api/retention-sales', async (req, res) => {
  const { orderCreatedBy } = req.query;
  try {
    const query = orderCreatedBy ? { orderCreatedBy } : {};
    // lean() for faster read-only queries
    const retentionSales = await RetentionSales.find(query).sort({ date: -1 }).lean();
    return res.status(200).json(retentionSales);
  } catch (error) {
    console.error("Error fetching retention sales:", error);
    return res.status(500).json({ message: "Error fetching retention sales", error });
  }
});

 
router.post('/api/retention-sales', async (req, res) => {
  const {
    date,
    name = "",
    contactNumber = "",
    productsOrdered = [],
    dosageOrdered = "",
    upsellAmount = 0, // New
    partialPayment = 0, // New
    modeOfPayment = "Not Specified",
    orderCreatedBy,
    remarks = "",
    orderId = "",
    shopify_amount = "",
    shipway_status = "",
  } = req.body;

  if (!date || !orderCreatedBy) {
    return res.status(400).json({ message: "Date and orderCreatedBy are required." });
  }

  try {
    const amountPaid = upsellAmount + partialPayment;  

    const newSale = new RetentionSales({
      date,
      name,
      contactNumber,
      productsOrdered,
      dosageOrdered,
      upsellAmount,
      partialPayment,
      amountPaid, // Updated Amount Paid
      modeOfPayment,
      orderCreatedBy,
      remarks,
      orderId,
      shopify_amount,
      shipway_status
    });

    await newSale.save();
    res.status(201).json(newSale);
  } catch (error) {
    console.error('Error adding retention sale:', error);
    res.status(500).json({ message: 'Error adding retention sale', error });
  }
});

/**
 * 5. PUT: Update a retention sale by ID
 */
router.put('/api/retention-sales/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const updatedSale = await RetentionSales.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedSale) {
      return res.status(404).json({ message: 'Sale not found' });
    }
    res.status(200).json(updatedSale);
  } catch (error) {
    console.error('Error updating retention sale:', error);
    res.status(500).json({ message: 'Error updating retention sale', error });
  }
});

// In routes/retentionSalesRoutes.js, update the delete endpoint:
router.delete('/api/retention-sales/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Try deleting from RetentionSales first.
    let deletedSale = await RetentionSales.findByIdAndDelete(id);
    if (!deletedSale) {
      // If not found, try deleting from MyOrder collection.
      deletedSale = await MyOrder.findByIdAndDelete(id);
      if (!deletedSale) {
        return res.status(404).json({ message: 'Sale not found in either collection' });
      }
    }
    res.status(200).json({ message: 'Sale deleted successfully' });
  } catch (error) {
    console.error('Error deleting sale:', error);
    res.status(500).json({ message: 'Error deleting sale', error });
  }
});

 
router.post('/api/retention-sales/update-matching', async (req, res) => {
  try {
    // 1. Fetch all retention sales
    const retentionSales = await RetentionSales.find({}).sort({ date: -1 }).lean();
    if (retentionSales.length === 0) {
      return res.status(200).json({ message: "No retention sales to update." });
    }

    // 2. Determine overall date range (expand one day on each side)
    const dates = retentionSales.map(sale => new Date(sale.date));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const startDate = new Date(minDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const endDate = new Date(maxDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

    // 3. Build Shopify API URL
    const startEncoded = encodeURIComponent(startDate);
    const endEncoded = encodeURIComponent(endDate);
    const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=${startEncoded}&created_at_max=${endEncoded}&limit=250`;

    // Helper function to recursively fetch Shopify orders
    const fetchAllOrders = async (url, allOrders = []) => {
      try {
        const response = await axios.get(url, {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_API_SECRET,
            'Content-Type': 'application/json',
          },
        });
        if (!response.data.orders) {
          return allOrders;
        }
        allOrders = allOrders.concat(response.data.orders);

        const nextLinkHeader = response.headers.link;
        if (nextLinkHeader) {
          const match = nextLinkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (match && match[1]) {
            return fetchAllOrders(match[1], allOrders);
          }
        }
        return allOrders;
      } catch (err) {
        console.error('Error fetching Shopify orders:', err);
        return allOrders;
      }
    };

    // 4. Fetch all Shopify orders in this date range
    const shopifyOrders = await fetchAllOrders(shopifyAPIEndpoint);

    // 5. Process each sale in parallel
    const updatePromises = retentionSales.map(async (sale) => {
      const saleDate = new Date(sale.date);
      const nextDay = new Date(saleDate.getTime() + 24 * 60 * 60 * 1000);
      const normalizedSalePhone = normalizePhoneNumber(sale.contactNumber);

      // Filter Shopify orders within that day range
      const ordersInDate = shopifyOrders.filter((order) => {
        const orderDate = new Date(order.created_at);
        return orderDate >= saleDate && orderDate < nextDay;
      });

      // Attempt phone+date match
      const matchedOrder = ordersInDate.find((order) => {
        const shopifyPhone =
          order.customer && order.customer.default_address
            ? order.customer.default_address.phone
            : "";
        return normalizePhoneNumber(shopifyPhone) === normalizedSalePhone;
      });

      let updatedFields = {};
      if (matchedOrder) {
        // Full match => set orderId/shopify_amount
        updatedFields.orderId = matchedOrder.name; // e.g., "#MA40491"
        updatedFields.shopify_amount = matchedOrder.total_price;

        // Check Shipway status
        const normalizedOrderId = matchedOrder.name.startsWith("#")
          ? matchedOrder.name.slice(1)
          : matchedOrder.name;
        const shipwayOrder = await Order.findOne({ order_id: normalizedOrderId }).lean();
        updatedFields.shipway_status = shipwayOrder ? shipwayOrder.shipment_status : "";
      } else {
        // No match => clear these fields
        updatedFields.orderId = "";
        updatedFields.shopify_amount = "";
        updatedFields.shipway_status = "";
      }

      // 6. Update the sale in MongoDB
      await RetentionSales.findByIdAndUpdate(sale._id, updatedFields);
      return { _id: sale._id, ...updatedFields };
    });

    const updatedResults = await Promise.all(updatePromises);
    res.status(200).json({
      message: "Retention sales matching updated",
      updates: updatedResults,
    });
  } catch (error) {
    console.error("Error updating retention sales matching:", error);
    res.status(500).json({ message: "Error updating retention sales matching", error });
  }
});

router.get('/api/retention-sales/aggregated', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const retentionMatch = buildDateMatch(startDate, endDate);

    // Build match for MyOrder by orderDate
    let myOrderMatch = {};
    if (startDate || endDate) {
      myOrderMatch.orderDate = {};
      if (startDate) {
        myOrderMatch.orderDate.$gte = new Date(startDate);
      }
      if (endDate) {
        const endDateObj = new Date(endDate);
        endDateObj.setHours(23, 59, 59, 999);
        myOrderMatch.orderDate.$lte = endDateObj;
      }
    }

    const aggregatedData = await RetentionSales.aggregate([
      // ----- RetentionSales branch -----
      { $match: retentionMatch },
      {
        $project: {
          orderCreatedBy: 1,
          salesDone: { $literal: 1 },
          amountPaid: {
            $convert: { input: "$amountPaid", to: "double", onError: 0, onNull: 0 }
          }
        }
      },
      {
        $group: {
          _id: "$orderCreatedBy",
          retentionSalesDone: { $sum: "$salesDone" },
          retentionTotalSales: { $sum: "$amountPaid" }
        }
      },
      {
        $project: {
          agentName: "$_id",
          salesDone: "$retentionSalesDone",
          totalSales: "$retentionTotalSales"
        }
      },

      // ----- MyOrder branch via $unionWith -----
      {
        $unionWith: {
          coll: "myorders", // collection for MyOrder
          pipeline: [
            { $match: myOrderMatch },

            // Step 1: compute base amount (upsellAmount if > 0 else totalPrice)
            {
              $addFields: {
                _upsellAmt: {
                  $convert: { input: "$upsellAmount", to: "double", onError: 0, onNull: 0 }
                },
                _totalPrice: {
                  $convert: { input: "$totalPrice", to: "double", onError: 0, onNull: 0 }
                }
              }
            },
            {
              $addFields: {
                _baseAmount: {
                  $cond: [
                    { $gt: ["$_upsellAmt", 0] },
                    "$_upsellAmt",
                    "$_totalPrice"
                  ]
                }
              }
            },

            // Step 2: robust partial payments sum
            // Supports:
            //  - partialPayment as array of numbers/strings or objects with amount/value
            //  - partialPayment as single number/string
            //  - fallback to partialPayments (plural) if partialPayment missing
            {
              $addFields: {
                _partialRaw: { $ifNull: ["$partialPayment", "$partialPayments"] }
              }
            },
            {
              $addFields: {
                _partialPaymentsSum: {
                  $cond: [
                    { $isArray: "$_partialRaw" },
                    {
                      $sum: {
                        $map: {
                          input: "$_partialRaw",
                          as: "pp",
                          in: {
                            $convert: {
                              input: {
                                $ifNull: [
                                  { $ifNull: ["$$pp.amount", "$$pp.value"] },
                                  "$$pp" // the element itself if already number/string
                                ]
                              },
                              to: "double",
                              onError: 0,
                              onNull: 0
                            }
                          }
                        }
                      }
                    },
                    // Not an array → treat as single scalar (or 0)
                    {
                      $convert: {
                        input: { $ifNull: ["$_partialRaw", 0] },
                        to: "double",
                        onError: 0,
                        onNull: 0
                      }
                    }
                  ]
                }
              }
            },

            // Step 3: final projection for MyOrder
            {
              $project: {
                agentName: "$agentName",
                salesDone: { $literal: 1 },
                amountPaid: "$_baseAmount"
              }
            },

            // Step 4: group by agentName
            {
              $group: {
                _id: "$agentName",
                myOrderSalesDone: { $sum: "$salesDone" },
                myOrderTotalSales: { $sum: "$amountPaid" }
              }
            },
            {
              $project: {
                agentName: "$_id",
                salesDone: "$myOrderSalesDone",
                totalSales: "$myOrderTotalSales"
              }
            }
          ]
        }
      },

      // ----- Merge RetentionSales + MyOrder -----
      {
        $group: {
          _id: "$agentName",
          salesDone: { $sum: "$salesDone" },
          totalSales: { $sum: "$totalSales" }
        }
      },
      {
        $project: {
          agentName: "$_id",
          salesDone: 1,
          totalSales: 1,
          avgOrderValue: {
            $cond: [
              { $eq: ["$salesDone", 0] },
              0,
              { $divide: ["$totalSales", "$salesDone"] }
            ]
          }
        }
      }
    ]);

    res.status(200).json(aggregatedData);
  } catch (error) {
    console.error("Error aggregating sales:", error);
    res.status(500).json({ message: "Error aggregating sales", error: error.message });
  }
});
 

// Helper to convert Date to YYYY-MM-DD in IST
function toISODate(d) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const ist = new Date(utc + istOffsetMs);
  return ist.toISOString().split("T")[0];
}

router.get("/api/retention-sales/aggregated-followup", async (req, res) => {
  try {
    // 1. Get all active retention agents
    const activeAgents = await Employee.find(
      { role: "Retention Agent", status: "active" },
      { fullName: 1 }
    ).lean();
    const agentNames = activeAgents.map(({ fullName }) => fullName);

    // 2. Calculate IST-adjusted today and tomorrow
    const today = toISODate(new Date());
    const tomorrow = toISODate(new Date(Date.now() + 24 * 60 * 60 * 1000));

    // 3. Filter for retentionStatus null or Active
    const retentionStatusFilter = {
      $or: [{ retentionStatus: null }, { retentionStatus: "Active" }],
    };

    // 4. For each agent, get metrics
    const summary = await Promise.all(
      agentNames.map(async (agentName) => {
        const [
          noFollowupSet,
          followupMissed,
          followupToday,
          followupTomorrow,
          followupLater,
          lostCustomers,
        ] = await Promise.all([
          // No Followup Set
          Lead.countDocuments({
            $and: [
              { healthExpertAssigned: agentName },
              retentionStatusFilter,
              {
                $or: [
                  { rtNextFollowupDate: { $exists: false } },
                  { rtNextFollowupDate: null },
                  { rtNextFollowupDate: "" },
                ],
              },
            ],
          }),

          // Followup Missed (before today)
          Lead.countDocuments({
            $and: [
              { healthExpertAssigned: agentName },
              retentionStatusFilter,
              { rtNextFollowupDate: { $lt: today } },
            ],
          }),

          // Followup Today
          Lead.countDocuments({
            $and: [
              { healthExpertAssigned: agentName },
              retentionStatusFilter,
              { rtNextFollowupDate: today },
            ],
          }),

          // Followup Tomorrow
          Lead.countDocuments({
            $and: [
              { healthExpertAssigned: agentName },
              retentionStatusFilter,
              { rtNextFollowupDate: tomorrow },
            ],
          }),

          // Followup Later (after tomorrow)
          Lead.countDocuments({
            $and: [
              { healthExpertAssigned: agentName },
              retentionStatusFilter,
              { rtNextFollowupDate: { $gt: tomorrow } },
            ],
          }),

          // Lost Customers (only retentionStatus = "Lost")
          Lead.countDocuments({
            healthExpertAssigned: agentName,
            retentionStatus: "Lost",
          }),
        ]);

        return {
          agentName,
          noFollowupSet,
          followupMissed,
          followupToday,
          followupTomorrow,
          followupLater,
          lostCustomers,
        };
      })
    );

    res.json({ summary });
  } catch (error) {
    console.error("Error fetching aggregated followup summary:", error);
    res.status(500).json({
      message: "Error fetching aggregated followup summary",
      error: error.message,
    });
  }
});


router.get('/api/retention-sales/shipment-summary/agent', async (req, res) => {
  const { agentName, startDate, endDate } = req.query;
  if (!agentName) {
    return res.status(400).json({ message: "Agent name is required" });
  }

  try {
    // For RetentionSales, build a match filter on agent and date.
    const retentionMatch = { 
      orderCreatedBy: agentName, 
      ...buildDateMatch(startDate, endDate)
    };

    const retentionPipeline = [
      { $match: retentionMatch },
      {
        $group: {
          _id: "$shipway_status",
          count: { $sum: 1 },
          totalAmount: { 
            $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } 
          }
        }
      },
      {
        $project: {
          category: {
            $cond: [
              { $or: [{ $eq: ["$_id", null] }, { $eq: ["$_id", ""] }] },
              "Not available",
              "$_id"
            ]
          },
          count: 1,
          totalAmount: 1
        }
      }
    ];

    // For MyOrder, match records for the agent and within the date range.
    let myOrderMatch = { agentName };
    if (startDate || endDate) {
      myOrderMatch.orderDate = {};
      if (startDate) {
        myOrderMatch.orderDate.$gte = new Date(startDate);
      }
      if (endDate) {
        const endObj = new Date(endDate);
        endObj.setHours(23, 59, 59, 999);
        myOrderMatch.orderDate.$lte = endObj;
      }
    }

    // MyOrder pipeline: normalize the order ID, lookup the corresponding Order
    // to get shipment status, and then group by that shipment status.
    const myOrderPipeline = [
      { $match: myOrderMatch },
      {
        $addFields: {
          normalizedOrderId: {
            $cond: [
              { $eq: [{ $substrCP: ["$orderId", 0, 1] }, "#"] },
              { $substrCP: ["$orderId", 1, { $subtract: [{ $strLenCP: "$orderId" }, 1] }] },
              "$orderId"
            ]
          }
        }
      },
      {
        $lookup: {
          from: "orders", // Ensure that this collection name matches yours
          localField: "normalizedOrderId",
          foreignField: "order_id",
          as: "orderDoc"
        }
      },
      { 
        $unwind: { path: "$orderDoc", preserveNullAndEmptyArrays: true } 
      },
      {
        $project: {
          // Use the shipment status from the looked-up Order or default to "Not available"
          shipmentStatus: { $ifNull: ["$orderDoc.shipment_status", "Not available"] },
          // For MyOrder, determine the effective amountPaid:
          // use upsellAmount if > 0, else totalPrice.
          amountPaid: {
            $cond: [
              { $gt: ["$upsellAmount", 0] },
              { $toDouble: "$upsellAmount" },
              { $toDouble: "$totalPrice" }
            ]
          }
        }
      },
      {
        $group: {
          _id: "$shipmentStatus",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amountPaid" }
        }
      },
      {
        $project: {
          category: "$_id",
          count: 1,
          totalAmount: 1
        }
      }
    ];

    // Use $unionWith to combine the two pipelines and then group by category.
    const combinedAggregation = await RetentionSales.aggregate([
      ...retentionPipeline,
      {
        $unionWith: {
          coll: "myorders",
          pipeline: myOrderPipeline
        }
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: "$count" },
          totalAmount: { $sum: "$totalAmount" }
        }
      },
      {
        $project: {
          category: "$_id",
          count: 1,
          totalAmount: 1
        }
      }
    ]);

    // Compute overall percentages and insert a "Total Orders" row.
    const totalCount = combinedAggregation.reduce((sum, item) => sum + item.count, 0);
    combinedAggregation.forEach(item => {
      item.percentage = totalCount ? ((item.count / totalCount) * 100).toFixed(2) : "0.00";
    });
    const totalAmount = combinedAggregation.reduce((sum, item) => sum + item.totalAmount, 0);
    combinedAggregation.unshift({
      category: "Total Orders",
      count: totalCount,
      totalAmount: totalAmount,
      percentage: "100.00"
    });

    res.status(200).json(combinedAggregation);
  } catch (error) {
    console.error("Error aggregating agent shipment summary:", error);
    res.status(500).json({
      message: "Error aggregating agent shipment summary",
      error: error.message
    });
  }
});

router.get('/api/retention-sales/shipment-summary', async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const retentionMatch = buildDateMatch(startDate, endDate);

    const retentionPipeline = [
      { $match: retentionMatch },
      {
        $addFields: {
          normalizedOrderId: {
            $cond: [
              { $eq: [{ $substrCP: ["$orderId", 0, 1] }, "#"] },
              { $substrCP: ["$orderId", 1, { $subtract: [{ $strLenCP: "$orderId" }, 1] }] },
              "$orderId"
            ]
          }
        }
      },
      {
        $lookup: {
          from: "orders",
          localField: "normalizedOrderId",
          foreignField: "order_id",
          as: "orderDoc"
        }
      },
      {
        $unwind: {
          path: "$orderDoc",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          shipmentStatus: {
            $ifNull: ["$orderDoc.shipment_status", { $ifNull: ["$shipway_status", "Not available"] }]
          },
          amountPaid: { $toDouble: { $ifNull: ["$amountPaid", 0] } }
        }
      },
      {
        $group: {
          _id: "$shipmentStatus",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amountPaid" }
        }
      },
      {
        $project: {
          category: "$_id",
          count: 1,
          totalAmount: 1
        }
      }
    ];

    const myOrderMatch = {};
    if (startDate || endDate) {
      myOrderMatch.orderDate = {};
      if (startDate) myOrderMatch.orderDate.$gte = new Date(startDate);
      if (endDate) {
        const endObj = new Date(endDate);
        endObj.setHours(23, 59, 59, 999);
        myOrderMatch.orderDate.$lte = endObj;
      }
    }

    const myOrderPipeline = [
      { $match: myOrderMatch },
      {
        $addFields: {
          normalizedOrderId: {
            $cond: [
              { $eq: [{ $substrCP: ["$orderId", 0, 1] }, "#"] },
              { $substrCP: ["$orderId", 1, { $subtract: [{ $strLenCP: "$orderId" }, 1] }] },
              "$orderId"
            ]
          }
        }
      },
      {
        $lookup: {
          from: "orders",
          localField: "normalizedOrderId",
          foreignField: "order_id",
          as: "orderDoc"
        }
      },
      { $unwind: { path: "$orderDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          shipmentStatus: { $ifNull: ["$orderDoc.shipment_status", "Not available"] },
          amountPaid: {
            $cond: [
              { $gt: ["$upsellAmount", 0] },
              { $toDouble: "$upsellAmount" },
              { $toDouble: "$totalPrice" }
            ]
          }
        }
      },
      {
        $group: {
          _id: "$shipmentStatus",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amountPaid" }
        }
      },
      {
        $project: {
          category: "$_id",
          count: 1,
          totalAmount: 1
        }
      }
    ];

    const combinedAggregation = await RetentionSales.aggregate([
      ...retentionPipeline,
      {
        $unionWith: {
          coll: "myorders",
          pipeline: myOrderPipeline
        }
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: "$count" },
          totalAmount: { $sum: "$totalAmount" }
        }
      },
      {
        $project: {
          category: "$_id", 
          count: 1,
          totalAmount: 1
        }
      }
    ]);

    const totalCount = combinedAggregation.reduce((acc, curr) => acc + curr.count, 0);
    const totalAmount = combinedAggregation.reduce((acc, curr) => acc + curr.totalAmount, 0);

    const result = combinedAggregation.map(item => ({
      category: item.category,
      count: item.count,
      totalAmount: item.totalAmount,
      percentage: totalCount ? ((item.count / totalCount) * 100).toFixed(2) : "0.00"
    }));

    result.unshift({
      category: "Total Orders",
      count: totalCount,
      totalAmount: totalAmount,
      percentage: "100.00"
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Error in shipment summary:", error);
    res.status(500).json({ message: "Error", error: error.message });
  }
});

// Normalize date range to full day
const normalizeDate = (d) => {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
};

router.get("/api/retention-sales/cod-prepaid-summary", async (req, res) => {
  try {
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate & endDate are required" });
    }

    const start = normalizeDate(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // =========================
    // 1) Fetch Active Retention Agents
    // =========================
    const retentionAgents = await Employee.find({
      role: "Retention Agent",
      status: "active",
    }).select("fullName");

    // Build agent list
    const agentNames = retentionAgents.map((a) => a.fullName);

    // Prepare empty summary
    const summary = {};
    agentNames.forEach((name) => {
      summary[name] = {
        agentName: name,
        totalOrders: 0,
        codOrders: 0,
        prepaidOrders: 0,
      };
    });

    // =========================
    // 2) Fetch MyOrder orders within date range
    // =========================
    const myOrders = await MyOrder.find({
      agentName: { $in: agentNames },
      orderDate: { $gte: start, $lte: end },
    });

    myOrders.forEach((order) => {
      const agent = order.agentName;
      if (!summary[agent]) return;

      summary[agent].totalOrders += 1;

      if ((order.paymentMethod || "").toUpperCase() === "COD") {
        summary[agent].codOrders += 1;
      } else {
        summary[agent].prepaidOrders += 1;
      }
    });

    // =========================
    // 3) Fetch RetentionSales within date range
    // =========================
    const retentionSales = await RetentionSales.find({
      agentName: { $in: agentNames },
      createdAt: { $gte: start, $lte: end },
    });

    retentionSales.forEach((rs) => {
      const agent = rs.agentName;
      if (!summary[agent]) return;

      summary[agent].totalOrders += 1;

      if ((rs.modeOfPayment || "").toUpperCase() === "COD") {
        summary[agent].codOrders += 1;
      } else {
        summary[agent].prepaidOrders += 1;
      }
    });

    // Convert summary object to array
    const result = Object.values(summary);

    res.json(result);
  } catch (err) {
    console.error("Error in COD vs Prepaid Summary:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

function parseDateRange(req) {
  const { startDate, endDate } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const sDate = (startDate && startDate.length === 10) ? startDate : today;
  const eDate = (endDate && endDate.length === 10) ? endDate : today;
  return { sDate, eDate };
}

/**
 * GET /api/today-summary
 * Accepts: agentName, startDate, endDate
 * If startDate/endDate not provided, fallback to "today".
 */
router.get('/api/today-summary', async (req, res) => {
  try {
    const agentName = req.query.agentName;
    if (!agentName) {
      return res.status(400).json({ message: "agentName is required" });
    }

    // Parse date range from the query. RetentionSales stores date as string.
    const { sDate, eDate } = parseDateRange(req);

    // For MyOrder, convert these to Date objects.
    const startDateObj = new Date(sDate + "T00:00:00");
    const endDateObj = new Date(eDate + "T23:59:59.999");

    // 1. Query RetentionSales collection
    const retentionSales = await RetentionSales.find({
      orderCreatedBy: agentName,
      date: { $gte: sDate, $lte: eDate }
    });

    const retentionCount = retentionSales.length; 
    
    const retentionTotalSales = retentionSales.reduce(
      (acc, sale) => {
        const paid = Number(sale.amountPaid) || 0;
        const partial = Number(sale.partialPayment) || 0; 
        return acc + paid + partial;
      },
      0
    );


    // 2. Query MyOrder collection
    const myOrders = await MyOrder.find({
      agentName,
      orderDate: { $gte: startDateObj, $lte: endDateObj } 
    });

    const myOrdersCount = myOrders.length;
    
    const myOrdersTotalSales = myOrders.reduce((acc, order) => {
      const upsellAmount = Number(order.upsellAmount) || 0;
      const totalPrice = Number(order.totalPrice) || 0;
      const partialPayment = Number(order.partialPayment) || 0;
      const amountPaid = upsellAmount > 0 ? upsellAmount : totalPrice + partialPayment;
      return acc + amountPaid;
    }, 0);


    // 3. Compute combined metrics
    const combinedSalesDone = retentionCount + myOrdersCount;
    const combinedTotalSales = retentionTotalSales + myOrdersTotalSales;
    const combinedAvgOrderValue = combinedSalesDone > 0 ? combinedTotalSales / combinedSalesDone : 0;

    // 4. Compute Active Customers
    // For RetentionSales we assume the field is "contactNumber"
    // For MyOrder we assume the field is "phone"
    const retentionContacts = retentionSales.map(sale => sale.contactNumber);
    const myOrderContacts = myOrders.map(order => order.phone);
    // Combine and get unique values using a Set.
    const uniqueCustomers = new Set([...retentionContacts, ...myOrderContacts]);
    const activeCustomers = uniqueCustomers.size;

    res.json({
      activeCustomers,
      salesDone: combinedSalesDone,
      totalSales: Number(combinedTotalSales.toFixed(2)),
      avgOrderValue: Number(combinedAvgOrderValue.toFixed(2))
    });
  } catch (error) {
    console.error("Error in today-summary-agent:", error);
    res.status(500).json({ message: "Error fetching today summary", error: error.message });
  }
});

function parseDateOrToday(dateStr) {
  if (typeof dateStr === "string" && dateStr.length === 10) {
    return dateStr;
  }
  return new Date().toISOString().split("T")[0];
}

/**
 * GET /api/followup-summary
 * Accepts: agentName, startDate, endDate
 * If not provided, fallback to "today" logic.
 */
router.get("/api/followup-summary", async (req, res) => {
  try {
    const agentName = req.query.agentName;
    if (!agentName) {
      return res.status(400).json({ message: "agentName is required." });
    }

    // 1) Determine today and tomorrow as YYYY-MM-DD strings
    const todayStr = parseDateOrToday(req.query.startDate);
    const tomorrowDate = new Date(todayStr);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().split("T")[0];

    // 2) Only include active (or untagged) retentionStatus
    const retentionFilter = {
      $or: [{ retentionStatus: null }, { retentionStatus: "Active" }],
    };

    // 3) Count each bucket
    const noFollowupSet = await Lead.countDocuments({
  healthExpertAssigned: agentName,
  $and: [
    {
      $or: [
        { retentionStatus: null },
        { retentionStatus: "Active" }
      ],
    },
    {
      $or: [
        { rtNextFollowupDate: { $exists: false } },
        { rtNextFollowupDate: null },
        { rtNextFollowupDate: "" }
      ]
    }
  ]
});

    const followupMissed = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      ...retentionFilter,
      rtNextFollowupDate: { $lt: todayStr },
    });

    const followupToday = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      ...retentionFilter,
      rtNextFollowupDate: todayStr,
    });

    const followupTomorrow = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      ...retentionFilter,
      rtNextFollowupDate: tomorrowStr,
    });

    const followupLater = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      ...retentionFilter,
      rtNextFollowupDate: { $gt: tomorrowStr },
    });

    const lostCustomers = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      retentionStatus: "Lost",
    });

    return res.json({
      noFollowupSet,
      followupMissed,
      followupToday,
      followupTomorrow,
      followupLater,
      lostCustomers,
    });
  } catch (error) {
    console.error("Error fetching followup summary:", error);
    return res.status(500).json({
      message: "Error fetching followup summary",
      error: error.message,
    });
  }
});


router.get("/api/shipment-summary", async (req, res) => {
  try {
    const { agentName, startDate, endDate } = req.query;
    if (!agentName) {
      return res.status(400).json({ message: "Agent name is required." });
    }

    // ----------------------------
    // 1. Fetch RetentionSales Data
    // ----------------------------
    const retentionQuery = { orderCreatedBy: agentName };
    if (startDate || endDate) {
      retentionQuery.date = {};
      if (startDate) retentionQuery.date.$gte = startDate;
      if (endDate) retentionQuery.date.$lte = endDate;
    }

    const retentionSalesRaw = await RetentionSales.find(retentionQuery).lean();
    const retentionSales = retentionSalesRaw.map((sale) => {
      const status = sale.shipway_status || sale.shipment_status || "";
      const normalizedStatus = status.trim() || "Unknown";
      return {
        date: sale.date,
        shipway_status: normalizedStatus,
        amountPaid: Number(sale.amountPaid) || 0,
      };
    });

    // ----------------------------
    // 2. Fetch MyOrders with $lookup from Order collection
    // ----------------------------
    const matchStage = { agentName };
    if (startDate || endDate) {
      matchStage.orderDate = {};
      if (startDate) matchStage.orderDate.$gte = new Date(startDate);
      if (endDate) {
        const endObj = new Date(endDate);
        endObj.setHours(23, 59, 59, 999);
        matchStage.orderDate.$lte = endObj;
      }
    }

    const myOrders = await MyOrder.aggregate([
      { $match: matchStage },
      {
        $addFields: {
          normalizedOrderId: {
            $cond: [
              { $eq: [{ $substrCP: ["$orderId", 0, 1] }, "#"] },
              { $substrCP: ["$orderId", 1, { $subtract: [{ $strLenCP: "$orderId" }, 1] }] },
              "$orderId"
            ]
          }
        }
      },
      {
        $lookup: {
          from: "orders",
          localField: "normalizedOrderId",
          foreignField: "order_id",
          as: "orderDoc"
        }
      },
      {
        $unwind: {
          path: "$orderDoc",
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          orderDate: 1,
          amountPaid: {
            $cond: [
              { $gt: ["$upsellAmount", 0] },
              { $toDouble: "$upsellAmount" },
              { $toDouble: "$totalPrice" }
            ]
          },
          shipway_status: {
            $ifNull: ["$orderDoc.shipment_status", "Unknown"]
          }
        }
      }
    ]);

    const transformedMyOrders = myOrders.map((order) => ({
      date: order.orderDate
        ? new Date(order.orderDate).toISOString().split("T")[0]
        : "",
      shipway_status: order.shipway_status?.trim() || "Unknown",
      amountPaid: order.amountPaid || 0,
    }));

    // ----------------------------
    // 3. Combine & Aggregate Data
    // ----------------------------
    const combinedSales = [...retentionSales, ...transformedMyOrders];
    const statusMap = {};

    combinedSales.forEach((sale) => {
      const status = sale.shipway_status?.trim() || "Unknown";
      if (!statusMap[status]) {
        statusMap[status] = { count: 0, amount: 0 };
      }
      statusMap[status].count += 1;
      statusMap[status].amount += sale.amountPaid || 0;
    });

    const totalOrders = combinedSales.length;
    const totalAmount = combinedSales.reduce(
      (acc, sale) => acc + (sale.amountPaid || 0),
      0
    );

    // ----------------------------
    // 4. Build Final Summary
    // ----------------------------
    const summary = [
      {
        label: "Total Orders",
        count: totalOrders,
        amount: totalAmount,
        percentage: "100.00",
      },
    ];

    Object.entries(statusMap).forEach(([status, data]) => {
      const percentage =
        totalOrders > 0 ? ((data.count / totalOrders) * 100).toFixed(2) : "0.00";
      summary.push({
        label: status,
        count: data.count,
        amount: data.amount,
        percentage,
      });
    });

    res.status(200).json(summary);
  } catch (error) {
    console.error("Error fetching shipment summary:", error);
    res.status(500).json({
      message: "Error fetching shipment summary",
      error: error.message,
    });
  }
});


router.get('/api/retention-sales/all', async (req, res) => {
  try {
    const { orderCreatedBy } = req.query;
    const retentionQuery = orderCreatedBy ? { orderCreatedBy } : {};
    const myOrderQuery = orderCreatedBy ? { agentName: orderCreatedBy } : {};

    const retentionSales = await RetentionSales.find(retentionQuery).lean();
    const myOrders = await MyOrder.find(myOrderQuery).lean();

    const transformedOrders = myOrders.map(order => {
      const upsellAmount = Number(order.upsellAmount);
      const partialPayment = Number(order.partialPayment);
      const totalPrice = Number(order.totalPrice);

      // Calculate the correct amountPaid (totalPrice + partialPayment)
      let amountPaid = totalPrice + partialPayment + upsellAmount;  // Updated calculation

      return { 
        _id: order._id, 
        date: order.orderDate ? new Date(order.orderDate).toISOString().split("T")[0] : "",
        name: order.customerName,
        contactNumber: order.phone,
        productsOrdered: order.productOrdered,
        dosageOrdered: order.dosageOrdered,
        upsellAmount: upsellAmount,  
        partialPayment: partialPayment,  
        amountPaid: amountPaid,  // Updated amountPaid calculation
        modeOfPayment: order.paymentMethod,  
        shipway_status: order.shipway_status || "",  
        orderId: order.orderId,
        orderCreatedBy: order.agentName,
        remarks: order.selfRemark || "", 
        source: "MyOrder"
      };
    });

    const combinedData = [...retentionSales, ...transformedOrders]; 

    // Update the shipway_status from the corresponding Order document if missing
    await Promise.all(
      combinedData.map(async (sale) => {
        if (sale.orderId && (!sale.shipway_status || sale.shipway_status.trim() === "")) {
          const normalizedOrderId = sale.orderId.startsWith('#')
            ? sale.orderId.slice(1)
            : sale.orderId;
          const orderRecord = await Order.findOne({ order_id: normalizedOrderId }).lean();
          if (orderRecord) {
            sale.shipway_status = orderRecord.shipment_status;
          }
        }
      })
    );

    // Sort the combined data by date in descending order
    combinedData.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Return the combined and updated sales data
    res.status(200).json(combinedData);
  } catch (error) {
    console.error("Error fetching combined retention sales:", error);
    res.status(500).json({ message: "Error fetching combined retention sales", error: error.message });  
  }
});
 

router.get('/api/retention-sales/allapi', async (req, res) => {
  try {
    const { orderCreatedBy } = req.query;

    const toInFilter = (q) => {
      if (!q) return undefined;
      const arr = Array.isArray(q) ? q : [q];
      const clean = arr.map(s => String(s).trim()).filter(Boolean);
      return clean.length ? { $in: clean } : undefined;
    };

    const agentFilter = toInFilter(orderCreatedBy);
    const retentionQuery = agentFilter ? { orderCreatedBy: agentFilter } : {};
    const myOrderQuery   = agentFilter ? { agentName: agentFilter } : {};

    // Only select the fields you actually render in the table
    const [retentionSales, myOrders] = await Promise.all([
      RetentionSales.find(retentionQuery)
        .select('date name contactNumber productsOrdered dosageOrdered amountPaid modeOfPayment orderId shipway_status orderCreatedBy remarks')
        .lean(),
      MyOrder.find(myOrderQuery)
        .select('orderDate customerName phone productOrdered dosageOrdered upsellAmount partialPayment totalPrice paymentMethod shipway_status orderId agentName selfRemark')
        .lean(),
    ]);

    const transformedMyOrders = myOrders.map((order) => {
      const upsellAmount   = Number(order.upsellAmount || 0);
      const partialPayment = Number(order.partialPayment || 0);
      const totalPrice     = Number(order.totalPrice || 0);
      const dt = order.orderDate ? new Date(order.orderDate) : null;

      return {
        _id: order._id,
        date: dt ? dt.toISOString().split('T')[0] : '',
        name: order.customerName ?? '',
        contactNumber: order.phone ?? '',
        productsOrdered: order.productOrdered ?? '',
        dosageOrdered: order.dosageOrdered ?? '',
        upsellAmount,
        partialPayment,
        amountPaid: totalPrice + partialPayment + upsellAmount,
        modeOfPayment: order.paymentMethod ?? '',
        shipway_status: order.shipway_status ?? '',
        orderId: order.orderId ?? '',
        orderCreatedBy: order.agentName ?? '',
        remarks: order.selfRemark ?? '',
        source: 'MyOrder',
      };
    });

    const combinedData = [...retentionSales, ...transformedMyOrders];

    // Backfill shipway status only where missing
    const orderIdsToFetch = combinedData
      .filter(s => s.orderId && (!s.shipway_status || !s.shipway_status.trim()))
      .map(s => String(s.orderId).replace(/^#/, ''));
    const uniqueOrderIds = [...new Set(orderIdsToFetch)];

    let orderMap = {};
    if (uniqueOrderIds.length) {
      const orderRecords = await Order.find(
        { order_id: { $in: uniqueOrderIds } },
        { order_id: 1, shipment_status: 1, _id: 0 }
      ).lean();
      orderMap = orderRecords.reduce((acc, o) => {
        acc[o.order_id] = o.shipment_status || '';
        return acc;
      }, {});
    }

    for (const sale of combinedData) {
      if (sale.orderId && (!sale.shipway_status || !sale.shipway_status.trim())) {
        const normalizedId = String(sale.orderId).replace(/^#/, '');
        sale.shipway_status = orderMap[normalizedId] || '';
      }
    }

    // Single sort (desc)
    combinedData.sort((a, b) => {
      const ta = a.date ? new Date(a.date).getTime() : 0;
      const tb = b.date ? new Date(b.date).getTime() : 0;
      return tb - ta;
    });

    res.status(200).json(combinedData);
  } catch (error) {
    console.error('Error fetching combined retention sales:', error);
    res.status(500).json({ message: 'Error fetching combined retention sales', error: error.message });
  }
});


router.get('/api/retention-sales/allnew', async (req, res) => {
  const { orderCreatedBy, startDate, endDate } = req.query;

  // Build retention-sales query (date is a YYYY-MM-DD string)
  const retentionQuery = {};
  if (orderCreatedBy) retentionQuery.orderCreatedBy = orderCreatedBy;
  if (startDate || endDate) {
    retentionQuery.date = {};
    if (startDate) retentionQuery.date.$gte = startDate;
    if (endDate) retentionQuery.date.$lte = endDate;
  }

  // Build myorders query (orderDate is a JS Date)
  const myOrderQuery = {};
  if (orderCreatedBy) myOrderQuery.agentName = orderCreatedBy;
  if (startDate || endDate) {
    myOrderQuery.orderDate = {};
    if (startDate) myOrderQuery.orderDate.$gte = new Date(startDate);
    if (endDate) {
      const d = new Date(endDate);
      d.setHours(23, 59, 59, 999);
      myOrderQuery.orderDate.$lte = d;
    }
  }

  try {
    const [retentionSales, myOrders] = await Promise.all([
      RetentionSales.find(retentionQuery).lean(),
      MyOrder.find(myOrderQuery).lean(),
    ]);

    // Fetch matching Order entries by normalized orderId
    const orderIds = myOrders.map(o => o.orderId?.replace(/^#/, '')).filter(Boolean);
    const ordersMap = {};
    const orderDocs = await Order.find({ order_id: { $in: orderIds } }).lean();
    orderDocs.forEach(order => {
      ordersMap[order.order_id] = order;
    });

    const transformed = myOrders.map(order => {
      const normalizedOrderId = order.orderId?.replace(/^#/, '') || '';
      const shipwayOrder = ordersMap[normalizedOrderId] || {};

      return {
        _id: order._id,
        date: order.orderDate ? order.orderDate.toISOString().slice(0, 10) : '',
        orderId: order.orderId || '',
        contactNumber: order.phone || '',
        shipway_status: shipwayOrder.shipment_status || 'Not Available',
        tracking_number: shipwayOrder.tracking_number || '',
        carrier_title: shipwayOrder.carrier_title || '',
        amountPaid:
          Number(order.upsellAmount || 0) > 0
            ? Number(order.upsellAmount)
            : Number(order.totalPrice || 0) + Number(order.partialPayment || 0)
      };
    });

    const combined = [...retentionSales, ...transformed].sort((a, b) => {
      const aDate = a.date ? new Date(a.date) : new Date(0); 
      const bDate = b.date ? new Date(b.date) : new Date(0);
      return bDate - aDate;
    });

    res.json(combined);
  } catch (err) {
    console.error('Error fetching combined sales:', err);
    res.status(500).json({ message: 'Error fetching combined sales', error: err.message });
  }
});




router.put('/api/retention-sales/all/:id', async (req, res) => {
  const { id } = req.params;
  // Expect the update payload to have a field "source" indicating the origin.
  const { source, ...updateData } = req.body;
  
  try {
    let updatedRecord;
    if (source && source === "MyOrder") {
      // If the record is from the MyOrder collection, update it there.
      updatedRecord = await MyOrder.findByIdAndUpdate(id, updateData, { new: true });
      if (!updatedRecord) {
        return res.status(404).json({ message: "MyOrder record not found" });
      }
    } else {
      // Otherwise, update the record in the RetentionSales collection.
      updatedRecord = await RetentionSales.findByIdAndUpdate(id, updateData, { new: true });
      if (!updatedRecord) {
        return res.status(404).json({ message: "RetentionSales record not found" });
      }
    }
    res.status(200).json(updatedRecord);
  } catch (error) {
    console.error("Error updating combined record:", error);
    res.status(500).json({ message: "Error updating combined record", error: error.message });
  }
});

router.get('/api/retention-sales/progress', async (req, res) => {
  const { name, from, to } = req.query;
  if (!name) return res.status(400).json({ message: "Name is required" }); 

  // Use custom from-to if available, otherwise default to current month
  let firstDay, lastDay;
  if (from && to) {
    firstDay = from;
    lastDay = to;
  } else {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    firstDay = `${yyyy}-${mm}-01`;
    const lastDayNum = new Date(yyyy, now.getMonth() + 1, 0).getDate();
    lastDay = `${yyyy}-${mm}-${String(lastDayNum).padStart(2, '0')}`;
  }

  try {
    // 1. RetentionSales sum
    const rsData = await RetentionSales.aggregate([
      {
        $match: {
          orderCreatedBy: name,
          date: { $gte: firstDay, $lte: lastDay }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } } 
        }
      }
    ]);
    const retentionTotal = rsData.length ? rsData[0].total : 0;

    // 2. MyOrder sum
    const startDateObj = new Date(firstDay + "T00:00:00");
    const endDateObj = new Date(lastDay + "T23:59:59.999");
    const moData = await MyOrder.aggregate([
      {
        $match: {
          agentName: name,
          orderDate: { $gte: startDateObj, $lte: endDateObj }
        }
      },
      {
        $project: {
          amountPaid: {
            $add: [
              { $toDouble: { $ifNull: ["$totalPrice", 0] } },
              { $toDouble: { $ifNull: ["$partialPayment", 0] } },
              { $toDouble: { $ifNull: ["$upsellAmount", 0] } }
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amountPaid" }
        }
      }
    ]);
    const myOrderTotal = moData.length ? moData[0].total : 0;

    const leadsData = await Lead.aggregate([
      {
        $match: {
          agentAssigned: name,
          salesStatus: "Sales Done",
          date: { $gte: firstDay, $lte: lastDay }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } }
        }
      }
    ]);
    const leadsTotal = leadsData.length ? leadsData[0].total : 0;

    res.json({
      total: retentionTotal + myOrderTotal + leadsTotal,
      retentionSales: retentionTotal,
      myOrderSales: myOrderTotal,
      leadSales: leadsTotal
    });
  } catch (err) {
    console.error("Error in retention-sales/progress:", err);
    res.status(500).json({ message: "Error calculating progress" });
  }
});


router.post('/api/retention-sales/progress-multiple', async (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ message: "names must be a non-empty array" });
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const firstDay = `${yyyy}-${mm}-01`;
  const lastDayNum = new Date(yyyy, now.getMonth() + 1, 0).getDate();
  const lastDay = `${yyyy}-${mm}-${String(lastDayNum).padStart(2, '0')}`;

  const startDateObj = new Date(firstDay + "T00:00:00");
  const endDateObj = new Date(lastDay + "T23:59:59.999");

  try {
    // Retention Sales
    const retentionData = await RetentionSales.aggregate([
      {
        $match: {
          orderCreatedBy: { $in: names },
          date: { $gte: firstDay, $lte: lastDay }
        }
      },
      {
        $group: {
          _id: "$orderCreatedBy",
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } }
        }
      }
    ]);

    // My Orders
    const myOrderData = await MyOrder.aggregate([
      {
        $match: {
          agentName: { $in: names },
          orderDate: { $gte: startDateObj, $lte: endDateObj }
        }
      },
      {
        $project: {
          agentName: 1,
          amountPaid: {
            $add: [
              { $toDouble: { $ifNull: ["$totalPrice", 0] } },
              { $toDouble: { $ifNull: ["$partialPayment", 0] } },
              { $toDouble: { $ifNull: ["$upsellAmount", 0] } }
            ]
          }
        }
      },
      {
        $group: {
          _id: "$agentName",
          total: { $sum: "$amountPaid" }
        }
      }
    ]);

    // Lead Sales
    const leadData = await Lead.aggregate([
      {
        $match: {
          agentAssigned: { $in: names },
          salesStatus: "Sales Done",
          date: { $gte: firstDay, $lte: lastDay }
        }
      },
      {
        $group: {
          _id: "$agentAssigned",
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } }
        }
      }
    ]);

    // Combine by name
    const totals = {};
    for (const name of names) totals[name] = 0;

    for (const { _id, total } of retentionData) totals[_id] += total;
    for (const { _id, total } of myOrderData) totals[_id] += total;
    for (const { _id, total } of leadData) totals[_id] += total;

    const result = names.map((name) => ({
      name,
      total: Math.round(totals[name] || 0),
    }));

    res.json(result);
  } catch (err) {
    console.error("Error in progress-multiple:", err);
    res.status(500).json({ message: "Failed to fetch totals" });
  }
});

router.post('/api/retention-sales/daywise-matrix', async (req, res) => {
  const { names, startDate, endDate } = req.body;
  if (!Array.isArray(names) || !startDate || !endDate)
    return res.status(400).json({ message: "names[], startDate, endDate required" });

  try {
    // Build date array between startDate and endDate
    const days = [];
    let d = new Date(startDate);
    const end = new Date(endDate);
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }

    // --- RetentionSales ---
    const rs = await RetentionSales.aggregate([
      { $match: { orderCreatedBy: { $in: names }, date: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { name: "$orderCreatedBy", date: "$date" },
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } },
        },
      },
    ]);

    // --- MyOrders ---
    const start = new Date(startDate);
    const endD = new Date(endDate + "T23:59:59.999");
    const mo = await MyOrder.aggregate([
      {
        $match: {
          agentName: { $in: names },
          orderDate: { $gte: start, $lte: endD },
        },
      },
      {
        $project: {
          name: "$agentName",
          date: { $dateToString: { format: "%Y-%m-%d", date: "$orderDate" } },
          total: {
            $add: [
              { $toDouble: { $ifNull: ["$totalPrice", 0] } },
              { $toDouble: { $ifNull: ["$partialPayment", 0] } },
              { $toDouble: { $ifNull: ["$upsellAmount", 0] } },
            ],
          },
        },
      },
      { $group: { _id: { name: "$name", date: "$date" }, total: { $sum: "$total" } } },
    ]);

    // --- Leads ---
    const ld = await Lead.aggregate([
      {
        $match: {
          agentAssigned: { $in: names },
          salesStatus: "Sales Done",
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { name: "$agentAssigned", date: "$date" },
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } },
        },
      },
    ]);

    // Combine all sources
    const map = {};
    const addToMap = (arr) => {
      for (const r of arr) {
        const key = `${r._id.name}-${r._id.date}`;
        map[key] = (map[key] || 0) + r.total;
      }
    };
    addToMap(rs);
    addToMap(mo);
    addToMap(ld);

    // Build matrix result
    const result = names.map((name) => ({
      name,
      perDay: days.map((day) => ({
        date: day,
        total: map[`${name}-${day}`] || 0,
      })),
      grandTotal: days.reduce((acc, d) => acc + (map[`${name}-${d}`] || 0), 0),
    }));

    res.json(result);
  } catch (err) {
    console.error("Error in /daywise-matrix:", err);
    res.status(500).json({ message: "Error building daywise matrix", error: err.message });
  }
});

const normalizeOrderId = (v = "") =>
  String(v).replace(/^#/, "").trim();

const normalizeDateRange = (startDate, endDate) => {
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate + "T23:59:59.999") : null;
  return { start, end };
};
 
router.get("/api/incentives", async (req, res) => {
  try {
    const { agentName, startDate, endDate } = req.query;
    if (!agentName) {
      return res.status(400).json({ message: "agentName is required" });
    }
 
    const employee = await Employee.findOne(
      { fullName: agentName },
      { role: 1 }
    ).lean();

    if (!employee) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const role = employee.role;
    const { start, end } = normalizeDateRange(startDate, endDate);

    let rows = [];
 
    if (role === "Sales Agent") {
      // ---------- Leads ----------
      const leadQuery = { agentAssigned: agentName };
      if (startDate || endDate) {
        leadQuery.date = {};
        if (startDate) leadQuery.date.$gte = startDate;
        if (endDate) leadQuery.date.$lte = endDate;
      }

      const leads = await Lead.find(leadQuery).lean();

      // ---------- MyOrders ----------
      const myOrderQuery = { agentName };
      if (start || end) {
        myOrderQuery.orderDate = {};
        if (start) myOrderQuery.orderDate.$gte = start;
        if (end) myOrderQuery.orderDate.$lte = end;
      }

      const myOrders = await MyOrder.find(myOrderQuery).lean();

      rows = [
        // 🔹 Lead → amountPaid
        ...leads.map((l) => ({
          date: l.date,
          name: l.name,
          orderId: l.orderId || "",
          phone: l.contactNumber || "",
          modeOfPayment: l.modeOfPayment || "",
          deliveryStatus: "",
          amount: Number(l.amountPaid || 0),
        })),

        // 🔹 MyOrder → totalPrice + partialPayment + upsellAmount
        ...myOrders.map((o) => ({
          date: o.orderDate
            ? o.orderDate.toISOString().slice(0, 10)
            : "",
          name: o.customerName,
          orderId: o.orderId || "",
          phone: o.phone || "",
          modeOfPayment: o.paymentMethod || "",
          deliveryStatus: "",
          amount:
            Number(o.totalPrice || 0) +
            Number(o.partialPayment || 0) +
            Number(o.upsellAmount || 0),
        })),
      ];
    }
 
    if (role === "Retention Agent") { 
      const retentionQuery = { orderCreatedBy: agentName };
      if (startDate || endDate) {
        retentionQuery.date = {};
        if (startDate) retentionQuery.date.$gte = startDate;
        if (endDate) retentionQuery.date.$lte = endDate;
      }

      const retentionSales = await RetentionSales.find(retentionQuery).lean();

      // ---------- MyOrders ----------
      const myOrderQuery = { agentName };
      if (start || end) {
        myOrderQuery.orderDate = {};
        if (start) myOrderQuery.orderDate.$gte = start;
        if (end) myOrderQuery.orderDate.$lte = end;
      }

      const myOrders = await MyOrder.find(myOrderQuery).lean();

      rows = [
        // 🔹 RetentionSales → amountPaid
        ...retentionSales.map((r) => ({
          date: r.date,
          name: r.name || "",
          orderId: r.orderId || "",
          phone: r.contactNumber || "",
          modeOfPayment: r.modeOfPayment || "",
          deliveryStatus: r.shipway_status || "",
          amount: Number(r.amountPaid || 0),
        })),
 
        ...myOrders.map((o) => ({
          date: o.orderDate
            ? o.orderDate.toISOString().slice(0, 10)
            : "",
          name: o.customerName,
          orderId: o.orderId || "",
          phone: o.phone || "",
          modeOfPayment: o.paymentMethod || "",
          deliveryStatus: "",
          amount:
            Number(o.totalPrice || 0) +
            Number(o.partialPayment || 0) +
            Number(o.upsellAmount || 0),
        })),
      ];
    }
 
    const orderIdVariants = new Set();

    rows.forEach((r) => {
      if (!r.orderId) return;

      const raw = String(r.orderId).trim();
      const clean = normalizeOrderId(raw);

      orderIdVariants.add(raw);
      orderIdVariants.add(clean);
      orderIdVariants.add(`#${clean}`);
    });

    const orderIds = [...orderIdVariants];

    if (orderIds.length) {
      const orders = await Order.find(
        { order_id: { $in: orderIds } },
        { order_id: 1, shipment_status: 1 }
      ).lean();

      const shipwayMap = orders.reduce((acc, o) => {
        const clean = normalizeOrderId(o.order_id);
        acc[clean] = o.shipment_status || "";
        return acc;
      }, {});

      rows = rows.map((r) => {
        if (!r.deliveryStatus && r.orderId) {
          const clean = normalizeOrderId(r.orderId);
          r.deliveryStatus = shipwayMap[clean] || "";
        }
        return r;
      });
    }
 
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(rows);
  } catch (error) {
    console.error("Error in /api/incentives:", error);
    res.status(500).json({
      message: "Failed to fetch incentives",
      error: error.message,
    });
  }
});

module.exports = router;
