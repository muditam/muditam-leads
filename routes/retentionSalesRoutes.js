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

const ShopifyOrder = require("../models/ShopifyOrder");
const SOP = require("../models/Wallet/SOP");
const WalletCashToCoinConversion = require("../models/Wallet/WalletCashToCoinConversion");
const WalletCoinRedemption = require("../models/Wallet/WalletCoinRedemption");

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
 
      {
        $unionWith: {
          coll: "myorders", // collection for MyOrder
          pipeline: [
            { $match: myOrderMatch },
 
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
    if (!startDate || !endDate) return res.status(400).json({ message: "Dates required" });

    const start = normalizeDate(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const agents = await Employee.find({ role: "Retention Agent", status: "active" }).select("fullName");
    const summary = {};
    agents.forEach(a => {
      summary[a.fullName] = { agentName: a.fullName, totalOrders: 0, codOrders: 0, prepaidOrders: 0, partialOrders: 0 };
    });

    // 1. MyOrder Processing
    const myOrders = await MyOrder.find({ agentName: { $in: Object.keys(summary) }, orderDate: { $gte: start, $lte: end } });
    myOrders.forEach(o => {
      summary[o.agentName].totalOrders++;
      if (Number(o.partialPayment) > 0) summary[o.agentName].partialOrders++;
      else if ((o.paymentMethod || "").toUpperCase() === "COD") summary[o.agentName].codOrders++;
      else summary[o.agentName].prepaidOrders++;
    });

    // 2. RetentionSales Processing
    const rs = await RetentionSales.find({ orderCreatedBy: { $in: Object.keys(summary) }, date: { $gte: startDate, $lte: endDate } });
    rs.forEach(s => {
      summary[s.orderCreatedBy].totalOrders++;
      if (Number(s.partialPayment) > 0) summary[s.orderCreatedBy].partialOrders++;
      else if ((s.modeOfPayment || "").toUpperCase() === "COD") summary[s.orderCreatedBy].codOrders++;
      else summary[s.orderCreatedBy].prepaidOrders++;
    });

    res.json(Object.values(summary));
  } catch (err) {
    res.status(500).json({ message: "Error", error: err.message });
  }
});

function parseDateRange(req) {
  const { startDate, endDate } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const sDate = (startDate && startDate.length === 10) ? startDate : today;
  const eDate = (endDate && endDate.length === 10) ? endDate : today;
  return { sDate, eDate };
}

router.get("/api/today-summary", async (req, res) => {
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

    // 1) RetentionSales collection
    const retentionSales = await RetentionSales.find({
      orderCreatedBy: agentName,
      date: { $gte: sDate, $lte: eDate },
    }).lean();

    const retentionCount = retentionSales.length;

    // ✅ IGNORE partialPayment completely
    const retentionTotalSales = retentionSales.reduce((acc, sale) => {
      const paid = Number(sale.amountPaid) || 0;
      return acc + paid;
    }, 0);

    // 2) MyOrder collection
    const myOrders = await MyOrder.find({
      agentName,
      orderDate: { $gte: startDateObj, $lte: endDateObj },
    }).lean();

    const myOrdersCount = myOrders.length;

    // ✅ IGNORE partialPayment completely
    const myOrdersTotalSales = myOrders.reduce((acc, order) => {
      const upsellAmount = Number(order.upsellAmount) || 0;
      const totalPrice = Number(order.totalPrice) || 0;

      const amountPaid = upsellAmount > 0 ? upsellAmount : totalPrice;
      return acc + amountPaid;
    }, 0);

    // 3) Combined metrics
    const combinedSalesDone = retentionCount + myOrdersCount;
    const combinedTotalSales = retentionTotalSales + myOrdersTotalSales;
    const combinedAvgOrderValue =
      combinedSalesDone > 0 ? combinedTotalSales / combinedSalesDone : 0;

    // 4) Active Customers (unique)
    const retentionContacts = retentionSales
      .map((sale) => sale.contactNumber)
      .filter(Boolean);

    const myOrderContacts = myOrders.map((order) => order.phone).filter(Boolean);

    const uniqueCustomers = new Set([...retentionContacts, ...myOrderContacts]);
    const activeCustomers = uniqueCustomers.size;

    res.json({
      activeCustomers,
      salesDone: combinedSalesDone,
      totalSales: Number(combinedTotalSales.toFixed(2)),
      avgOrderValue: Number(combinedAvgOrderValue.toFixed(2)),
    });
  } catch (error) {
    console.error("Error in today-summary-agent:", error);
    res.status(500).json({
      message: "Error fetching today summary",
      error: error.message,
    });
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

router.get("/api/retention-sales/all", async (req, res) => {
  try {
    const { orderCreatedBy } = req.query;

    const retentionQuery = orderCreatedBy ? { orderCreatedBy } : {};
    const myOrderQuery = orderCreatedBy ? { agentName: orderCreatedBy } : {};

    const retentionSales = await RetentionSales.find(retentionQuery).lean();
    const myOrders = await MyOrder.find(myOrderQuery).lean();

    const transformedOrders = myOrders.map((order) => {
      const upsellAmount = Number(order.upsellAmount || 0);
      const partialPayment = Number(order.partialPayment || 0); // pending/due
      const totalPrice = Number(order.totalPrice || 0);

      let amountPaid = totalPrice + upsellAmount - partialPayment;
      if (amountPaid < 0) amountPaid = 0;

      return {
        _id: order._id,
        date: order.orderDate
          ? new Date(order.orderDate).toISOString().split("T")[0]
          : "",
        name: order.customerName || "",
        contactNumber: order.phone || "",
        productsOrdered: order.productOrdered || [],
        dosageOrdered: order.dosageOrdered || "",
        upsellAmount,
        partialPayment, // pending shown separately
        amountPaid, // paid after subtracting pending
        modeOfPayment: order.paymentMethod || "",
        shipway_status: order.shipway_status || "",
        orderId: order.orderId || "",
        orderCreatedBy: order.agentName || "",
        remarks: order.selfRemark || "",
        source: "MyOrder",
      };
    });

    const combinedData = [...retentionSales, ...transformedOrders];

    // Backfill shipway_status from Order collection if missing
    await Promise.all(
      combinedData.map(async (sale) => {
        if (
          sale.orderId &&
          (!sale.shipway_status || String(sale.shipway_status).trim() === "")
        ) {
          const normalizedOrderId = String(sale.orderId).startsWith("#")
            ? String(sale.orderId).slice(1)
            : String(sale.orderId);

          const orderRecord = await Order.findOne({
            order_id: normalizedOrderId,
          }).lean();

          if (orderRecord) {
            sale.shipway_status = orderRecord.shipment_status || "";
          }
        }
      })
    );

    // Sort by date desc (safe even if date is empty)
    combinedData.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return db - da;
    });

    return res.status(200).json(combinedData);
  } catch (error) {
    console.error("Error fetching combined retention sales:", error);
    return res.status(500).json({
      message: "Error fetching combined retention sales",
      error: error.message,
    });
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
    const myOrderQuery = agentFilter ? { agentName: agentFilter } : {};

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
      const upsellAmount = Number(order.upsellAmount || 0);
      const partialPayment = Number(order.partialPayment || 0);
      const totalPrice = Number(order.totalPrice || 0);
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

router.get("/api/retention-sales/progress", async (req, res) => {
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
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    firstDay = `${yyyy}-${mm}-01`;
    const lastDayNum = new Date(yyyy, now.getMonth() + 1, 0).getDate();
    lastDay = `${yyyy}-${mm}-${String(lastDayNum).padStart(2, "0")}`;
  }

  try {
    // 1) RetentionSales sum (unchanged)
    const rsData = await RetentionSales.aggregate([
      {
        $match: {
          orderCreatedBy: name,
          date: { $gte: firstDay, $lte: lastDay },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } },
          },
        },
      },
    ]);
    const retentionTotal = rsData.length ? rsData[0].total : 0;

    // 2) MyOrder sum ✅ ignore partialPayment completely
    const startDateObj = new Date(firstDay + "T00:00:00");
    const endDateObj = new Date(lastDay + "T23:59:59.999");

    const moData = await MyOrder.aggregate([
      {
        $match: {
          agentName: name,
          orderDate: { $gte: startDateObj, $lte: endDateObj },
        },
      },
      {
        $project: {
          _upsell: { $toDouble: { $ifNull: ["$upsellAmount", 0] } },
          _total: { $toDouble: { $ifNull: ["$totalPrice", 0] } },
        },
      },
      {
        $project: {
          amountPaid: {
            $cond: [{ $gt: ["$_upsell", 0] }, "$_upsell", "$_total"],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amountPaid" },
        },
      },
    ]);

    const myOrderTotal = moData.length ? moData[0].total : 0;

    // 3) Lead sales (unchanged)
    const leadsData = await Lead.aggregate([
      {
        $match: {
          agentAssigned: name,
          salesStatus: "Sales Done",
          date: { $gte: firstDay, $lte: lastDay },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } },
          },
        },
      },
    ]);
    const leadsTotal = leadsData.length ? leadsData[0].total : 0;

    res.json({
      total: retentionTotal + myOrderTotal + leadsTotal,
      retentionSales: retentionTotal,
      myOrderSales: myOrderTotal,
      leadSales: leadsTotal,
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
  if (!Array.isArray(names) || !startDate || !endDate) {
    return res.status(400).json({ message: "names[], startDate, endDate required" });
  }

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
      {
        $match: {
          orderCreatedBy: { $in: names },
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: { name: "$orderCreatedBy", date: "$date" },
          total: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } },
        },
      },
    ]);

    // --- MyOrders --- ✅ IGNORE partialPayment (like /api/incentives)
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

          _upsell: {
            $convert: { input: "$upsellAmount", to: "double", onError: 0, onNull: 0 },
          },
          _total: {
            $convert: { input: "$totalPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },
      {
        $project: {
          name: 1,
          date: 1,
          total: {
            $cond: [{ $gt: ["$_upsell", 0] }, "$_upsell", "$_total"],
          },
        },
      },
      {
        $group: {
          _id: { name: "$name", date: "$date" },
          total: { $sum: "$total" },
        },
      },
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
        map[key] = (map[key] || 0) + (Number(r.total) || 0);
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
      grandTotal: days.reduce((acc, day) => acc + (map[`${name}-${day}`] || 0), 0),
    }));

    return res.json(result);
  } catch (err) {
    console.error("Error in /daywise-matrix:", err);
    return res.status(500).json({
      message: "Error building daywise matrix",
      error: err.message,
    });
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

        // 🔹 MyOrder → IGNORE partialPayment
        ...myOrders.map((o) => {
          const upsell = Number(o.upsellAmount || 0);
          const total = Number(o.totalPrice || 0);

          return {
            date: o.orderDate ? o.orderDate.toISOString().slice(0, 10) : "",
            name: o.customerName,
            orderId: o.orderId || "",
            phone: o.phone || "",
            modeOfPayment: o.paymentMethod || "",
            deliveryStatus: "",
            amount: upsell > 0 ? upsell : total, // ✅ no partialPayment
          };
        }),
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
        // 🔹 RetentionSales → amountPaid (your stored value)
        ...retentionSales.map((r) => ({
          date: r.date,
          name: r.name || "",
          orderId: r.orderId || "",
          phone: r.contactNumber || "",
          modeOfPayment: r.modeOfPayment || "",
          deliveryStatus: r.shipway_status || "",
          amount: Number(r.amountPaid || 0),
        })),

        // 🔹 MyOrder → IGNORE partialPayment
        ...myOrders.map((o) => {
          const upsell = Number(o.upsellAmount || 0);
          const total = Number(o.totalPrice || 0);

          return {
            date: o.orderDate ? o.orderDate.toISOString().slice(0, 10) : "",
            name: o.customerName,
            orderId: o.orderId || "",
            phone: o.phone || "",
            modeOfPayment: o.paymentMethod || "",
            deliveryStatus: "",
            amount: upsell > 0 ? upsell : total, // ✅ no partialPayment
          };
        }),
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

const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];
const WALLET_COIN_START_DATE = "2026-04-01";
const CASH_TO_COIN_RATE = 1;

const PREPAID_COIN_VALUE = 20;
const PARTIAL_PAID_COIN_VALUE = 10;
const REFERRAL_PATIENT_COIN_VALUE = 200;

const PREPAID_PAYMENT_MODES = new Set([
  "razorpay",
  "prepaid",
  "upi",
  "bank transfer",
]);

const PARTIAL_PAID_PAYMENT_MODES = new Set([
  "partial paid",
  "partial_paid",
  "partial-paid",
  "partialpayment",
  "partial payment",
]);

const REFERRAL_LEAD_SOURCES = new Set([
  "reference",
  "referral",
  "referred",
]);

function isManager(role = "") {
  return MANAGER_ROLES.includes(String(role).toLowerCase());
}

function requireSession(req, res, next) {
  try {
    const headerUser = req.headers["x-session-user"];

    if (headerUser) {
      req.sessionUser = JSON.parse(headerUser);
      return next();
    }

    if (req.session?.user) {
      req.sessionUser = req.session.user;
      return next();
    }

    return res.status(401).json({ message: "Unauthorized" });
  } catch (error) {
    return res.status(401).json({ message: "Invalid session" });
  }
}

function hasFullAccess(user = {}) {
  return isManager(user.role) || user.hasTeam === true;
}

const INCENTIVE_SLABS = [
  { min: 0, max: 200000, percent: 1 },
  { min: 200000, max: 300000, percent: 1.5 },
  { min: 300000, max: 400000, percent: 2 },
  { min: 400000, max: 500000, percent: 2.5 },
  { min: 500000, max: 600000, percent: 3 },
  { min: 600000, max: 800000, percent: 3.5 },
  { min: 800000, max: 1000000, percent: 4 },
  { min: 1000000, max: Number.MAX_SAFE_INTEGER, percent: 4 },
];

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? round2(num) : 0;
}

function normalizeString(value = "") {
  return String(value || "").trim();
}

function normalizeComparable(value = "") {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}

function isPrepaidPaymentMode(mode = "") {
  const normalized = normalizeComparable(mode);
  return PREPAID_PAYMENT_MODES.has(normalized);
}

function isPartialPaidPaymentMode(mode = "") {
  const normalized = normalizeComparable(mode);
  return PARTIAL_PAID_PAYMENT_MODES.has(normalized);
}

function isReferralLeadSource(source = "") {
  const normalized = normalizeComparable(source);
  return REFERRAL_LEAD_SOURCES.has(normalized);
}

function getIncentivePercent(revenue = 0) {
  const value = Number(revenue || 0);
  const slab = INCENTIVE_SLABS.find(
    (item) => value >= item.min && value < item.max
  );
  return slab ? slab.percent : 0;
}

function isForcedDeliveredStatus(status) {
  return status === 0 || String(status).trim() === "0";
}

function isForcedDeliveredAmount(amount) {
  const amt = parseAmount(amount);
  return amt === 950 || amt === 300 || amt === 1900;
}

function normalizeShipmentStatus(status = "", amount = 0) {
  if (isForcedDeliveredStatus(status) || isForcedDeliveredAmount(amount)) {
    return "Delivered";
  }
  return String(status || "").trim();
}

function getWalletBucket(status = "", amount = 0) {
  const s = normalizeShipmentStatus(status, amount).toUpperCase().trim();

  if (!s) return "unknown";

  if (
    s.includes("RTO") ||
    s.includes("UNDELIVER") ||
    s.includes("CANCEL") ||
    s.includes("RETURN") ||
    s.includes("LOST") ||
    s.includes("NDR") ||
    s.includes("FAILED")
  ) {
    return "reversed";
  }

  if (s.includes("DELIVERED")) {
    return "available";
  }

  if (
    s.includes("PROCESSING") ||
    s.includes("CREATED") ||
    s.includes("NEW") ||
    s.includes("OPEN") ||
    s.includes("CONFIRMED") ||
    s.includes("READY TO SHIP") ||
    s.includes("AWB") ||
    s.includes("IN TRANSIT") ||
    s.includes("TRANSIT") ||
    s.includes("OUT FOR DELIVERY") ||
    s === "OFD" ||
    s.includes("SHIPPED") ||
    s.includes("DISPATCH") ||
    s.includes("MANIFEST") ||
    s.includes("PICKED") ||
    s.includes("PICKUP") ||
    s.includes("BOOKED") ||
    s.includes("REACHED HUB") ||
    s.includes("AT HUB")
  ) {
    return "coming";
  }

  return "unknown";
}

function sumAmountByBucket(rows, bucket) {
  return round2(
    rows
      .filter((r) => r.walletBucket === bucket)
      .reduce((sum, r) => sum + Number(r.amount || 0), 0)
  );
}

function countByBucket(rows, bucket) {
  return rows.filter((r) => r.walletBucket === bucket).length;
}

function getDaysOld(dateValue) {
  if (!dateValue) return null;

  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;

  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

const VKR_WALLET_SOP_NAME = "VKR Plan Wallet Coin";
const VKR_DAILY_TARGET = 2;
const VKR_MIN_ACHIEVEMENT_PERCENT = 60;

const VKR_VARIANT_COUNT_MAP = {
  48319092949302: 1,
  48791244603702: 2,
  48319093014838: 3,
};

function vkrRound2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function vkrParseAmount(value) {
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? vkrRound2(num) : 0;
}

function normalizeOrderIdLocal(v = "") {
  return String(v || "").trim().replace(/^#/, "");
}

function getDateRangeObjects(startDate, endDate) {
  const startObj = startDate ? new Date(`${startDate}T00:00:00.000`) : null;
  const endObj = endDate ? new Date(`${endDate}T23:59:59.999`) : null;
  return { startObj, endObj };
}

function countWorkingDaysExcludingSundays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return 0;
  }

  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    if (current.getDay() !== 0) count += 1;
    current.setDate(current.getDate() + 1);
  }

  return count;
}

function maxDateString(...dates) {
  const valid = dates.filter(Boolean).map((d) => String(d).slice(0, 10));
  if (!valid.length) return "";
  return valid.sort().slice(-1)[0];
}

function getEffectiveStartDateFromJoining(joiningDate, startDate) {
  let effective = startDate;

  if (joiningDate) {
    const joining = new Date(joiningDate);
    if (!Number.isNaN(joining.getTime())) {
      const joiningYMD = joining.toISOString().split("T")[0];
      effective = maxDateString(effective, joiningYMD);
    }
  }

  return effective;
}

function getWalletCoinEffectiveStartDate(joiningDate, startDate) {
  const joinedStart = getEffectiveStartDateFromJoining(joiningDate, startDate);
  return maxDateString(joinedStart, WALLET_COIN_START_DATE);
}

function isDeliveredShipmentStatus(status = "") {
  const s = String(status || "").trim().toUpperCase();
  if (!s) return false;
  if (s.includes("RTO")) return false;
  return s.includes("DELIVERED");
}

function dedupeSalesRowsByOrder(rows = []) {
  const seen = new Set();

  return rows.filter((row) => {
    const orderIdKey = normalizeOrderIdLocal(row.orderId);
    if (!orderIdKey) return false;

    const key = `order:${orderIdKey}`;
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function getVKRCountFromProducts(productsOrdered = []) {
  if (!Array.isArray(productsOrdered)) return 0;

  let total = 0;
  let onePackQty = 0;
  let threePackQty = 0;
  let hasOtherVkrPack = false;

  productsOrdered.forEach((product) => {
    const variantId = Number(product?.variant_id || 0);
    const mappedCount = Number(VKR_VARIANT_COUNT_MAP[variantId] || 0);
    const quantity = Number(product?.quantity || 1);
    const safeQty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;

    if (!mappedCount) return;

    total += mappedCount * safeQty;

    if (mappedCount === 1) {
      onePackQty += safeQty;
    } else if (mappedCount === 3) {
      threePackQty += safeQty;
    } else {
      hasOtherVkrPack = true;
    }
  });

  if (
    threePackQty === 1 &&
    onePackQty === 1 &&
    !hasOtherVkrPack &&
    total === 4
  ) {
    return 3;
  }

  return total;
}

function getMonthKeyFromDate(dateValue = "") {
  if (!dateValue) return "";
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) {
    return String(dateValue).slice(0, 7);
  }
  return d.toISOString().slice(0, 7);
}

function getCustomerKey(row = {}) {
  const phone = normalizeComparable(row.phone || row.contactNumber || "");
  if (phone) return `phone:${phone}`;

  const name = normalizeComparable(row.customerName || row.name || "");
  if (name) return `name:${name}`;

  const orderId = normalizeComparable(row.orderId || "");
  if (orderId) return `order:${orderId}`;

  return "";
}

function capRowsPerCustomerPerMonth(rows = [], maxPerMonth = 2) {
  const groupedCounter = new Map();

  return rows.filter((row) => {
    const monthKey = getMonthKeyFromDate(row.date);
    const customerKey = getCustomerKey(row);

    if (!monthKey || !customerKey) return false;

    const key = `${monthKey}__${customerKey}`;
    const currentCount = Number(groupedCounter.get(key) || 0);

    if (currentCount >= maxPerMonth) return false;

    groupedCounter.set(key, currentCount + 1);
    return true;
  });
}

function isEligibleReferralPatientRow(row = {}) {
  if (row.source !== "Lead") return false;
  if (!row.date) return false;
  if (!isReferralLeadSource(row.leadSource)) return false;

  const salesStatus = normalizeComparable(row.salesStatus);
  if (salesStatus !== "sales done") return false;

  return true;
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const formatYMD = (date) => {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  return {
    monthStart: formatYMD(start),
    monthEnd: formatYMD(end),
  };
}

function buildExtraCoinSummary(rows = []) {
  const prepaidEligibleRows = rows.filter((row) =>
    isPrepaidPaymentMode(row.modeOfPayment)
  );
  const partialPaidEligibleRows = rows.filter((row) =>
    isPartialPaidPaymentMode(row.modeOfPayment)
  );
  const referralEligibleRows = rows.filter((row) =>
    isEligibleReferralPatientRow(row)
  );

  const prepaidRows = capRowsPerCustomerPerMonth(prepaidEligibleRows, 2);
  const partialPaidRows = capRowsPerCustomerPerMonth(partialPaidEligibleRows, 2);

  const prepaidCount = prepaidRows.length;
  const partialPaidCount = partialPaidRows.length;
  const referralPatientCount = referralEligibleRows.length;

  const prepaidCoins = prepaidCount * PREPAID_COIN_VALUE;
  const partialPaidCoins = partialPaidCount * PARTIAL_PAID_COIN_VALUE;
  const referralPatientCoins = referralPatientCount * REFERRAL_PATIENT_COIN_VALUE;

  return {
    prepaidCount,
    partialPaidCount,
    referralPatientCount,
    prepaidCoins: round2(prepaidCoins),
    partialPaidCoins: round2(partialPaidCoins),
    referralPatientCoins: round2(referralPatientCoins),
    totalExtraCoins: round2(
      prepaidCoins + partialPaidCoins + referralPatientCoins
    ),
  };
}

async function getCashToCoinConversionSummary({
  agentName,
  startDate,
  endDate,
}) {
  const conversions = await WalletCashToCoinConversion.find({
    agentName,
    startDate,
    endDate,
  })
    .sort({ convertedAt: -1 })
    .lean();

  const totalCashConverted = round2(
    conversions.reduce((sum, item) => sum + Number(item.cashAmount || 0), 0)
  );

  const totalCoinReceived = round2(
    conversions.reduce((sum, item) => sum + Number(item.coinAmount || 0), 0)
  );

  return {
    conversions,
    totalCashConverted,
    totalCoinReceived,
  };
}

async function getWalletCoinRedemptionSummary({
  agentName,
  startDate,
  endDate,
}) {
  const redemptions = await WalletCoinRedemption.find({
    agentName,
    startDate,
    endDate,
  })
    .sort({ approvedAt: -1, createdAt: -1 })
    .lean();

  const totalCoinRedeemed = round2(
    redemptions.reduce((sum, item) => sum + Number(item.coinAmount || 0), 0)
  );

  return {
    redemptions,
    totalCoinRedeemed,
  };
}

async function buildCashWalletData({
  agentName,
  startDate,
  endDate,
  employee,
}) {
  const role = employee.role;
  const { startObj, endObj } = getDateRangeObjects(startDate, endDate);

  let rows = [];

  if (role === "Sales Agent") {
    const leadQuery = { agentAssigned: agentName };

    if (startDate || endDate) {
      leadQuery.date = {};
      if (startDate) leadQuery.date.$gte = startDate;
      if (endDate) leadQuery.date.$lte = endDate;
    }

    const leads = await Lead.find(leadQuery).lean();

    const myOrderQuery = { agentName };
    if (startObj || endObj) {
      myOrderQuery.orderDate = {};
      if (startObj) myOrderQuery.orderDate.$gte = startObj;
      if (endObj) myOrderQuery.orderDate.$lte = endObj;
    }

    const myOrders = await MyOrder.find(myOrderQuery).lean();

    rows = [
      ...leads.map((l) => ({
        source: "Lead",
        date: l.date,
        name: l.name || "",
        customerName: l.name || "",
        orderId: l.orderId || "",
        phone: l.contactNumber || "",
        modeOfPayment: l.modeOfPayment || "",
        leadSource: l.leadSource || "",
        salesStatus: l.salesStatus || "",
        deliveryStatus: "",
        amount: parseAmount(l.amountPaid),
      })),
      ...myOrders.map((o) => {
        const upsell = parseAmount(o.upsellAmount);
        const total = parseAmount(o.totalPrice);

        return {
          source: "MyOrder",
          date: o.orderDate ? o.orderDate.toISOString().slice(0, 10) : "",
          name: o.customerName || "",
          customerName: o.customerName || "",
          orderId: o.orderId || "",
          phone: o.phone || "",
          modeOfPayment: o.paymentMethod || "",
          leadSource: "",
          salesStatus: "",
          deliveryStatus: "",
          amount: upsell > 0 ? upsell : total,
        };
      }),
    ];
  } else if (role === "Retention Agent") {
    const retentionQuery = { orderCreatedBy: agentName };

    if (startDate || endDate) {
      retentionQuery.date = {};
      if (startDate) retentionQuery.date.$gte = startDate;
      if (endDate) retentionQuery.date.$lte = endDate;
    }

    const retentionSales = await RetentionSales.find(retentionQuery).lean();

    const myOrderQuery = { agentName };
    if (startObj || endObj) {
      myOrderQuery.orderDate = {};
      if (startObj) myOrderQuery.orderDate.$gte = startObj;
      if (endObj) myOrderQuery.orderDate.$lte = endObj;
    }

    const myOrders = await MyOrder.find(myOrderQuery).lean();

    rows = [
      ...retentionSales.map((r) => ({
        source: "RetentionSales",
        date: r.date,
        name: r.name || "",
        customerName: r.name || "",
        orderId: r.orderId || "",
        phone: r.contactNumber || "",
        modeOfPayment: r.modeOfPayment || "",
        leadSource: r.leadSource || "",
        salesStatus: r.salesStatus || "",
        deliveryStatus: r.shipway_status || "",
        amount: parseAmount(r.amountPaid),
      })),
      ...myOrders.map((o) => {
        const upsell = parseAmount(o.upsellAmount);
        const total = parseAmount(o.totalPrice);

        return {
          source: "MyOrder",
          date: o.orderDate ? o.orderDate.toISOString().slice(0, 10) : "",
          name: o.customerName || "",
          customerName: o.customerName || "",
          orderId: o.orderId || "",
          phone: o.phone || "",
          modeOfPayment: o.paymentMethod || "",
          leadSource: "",
          salesStatus: "",
          deliveryStatus: "",
          amount: upsell > 0 ? upsell : total,
        };
      }),
    ];
  } else {
    const error = new Error(
      "Incentives are only supported for Sales Agent and Retention Agent"
    );
    error.statusCode = 400;
    throw error;
  }

  const orderIdVariants = new Set();

  rows.forEach((r) => {
    if (!r.orderId) return;

    const raw = String(r.orderId).trim();
    const clean = normalizeOrderIdLocal(raw);

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

    const shipmentMap = orders.reduce((acc, o) => {
      const clean = normalizeOrderIdLocal(o.order_id);
      acc[clean] = o.shipment_status;
      return acc;
    }, {});

    rows = rows.map((r) => {
      if (!r.deliveryStatus && r.orderId) {
        const clean = normalizeOrderIdLocal(r.orderId);
        r.deliveryStatus = shipmentMap[clean] ?? "";
      }
      return r;
    });
  }

  rows.sort((a, b) => new Date(b.date) - new Date(a.date));

  rows = rows.map((r) => {
    const amount = parseAmount(r.amount);
    const deliveryStatus = normalizeShipmentStatus(r.deliveryStatus, amount);
    const walletBucket = getWalletBucket(deliveryStatus, amount);
    const daysOld = getDaysOld(r.date);

    const isAtRisk =
      walletBucket === "coming" &&
      daysOld !== null &&
      daysOld > 5;

    return {
      ...r,
      amount,
      deliveryStatus,
      walletBucket,
      daysOld,
      isAtRisk,
    };
  });

  const deliveredRevenue = sumAmountByBucket(rows, "available");
  const comingRevenue = sumAmountByBucket(rows, "coming");
  const reversedRevenue = sumAmountByBucket(rows, "reversed");
  const unknownRevenue = sumAmountByBucket(rows, "unknown");

  const totalRevenue = round2(
    deliveredRevenue + comingRevenue + reversedRevenue + unknownRevenue
  );

  const deliveredPercent = getIncentivePercent(deliveredRevenue);
  const totalPercent = getIncentivePercent(totalRevenue);

  rows = rows.map((r) => {
    const incentiveAmount =
      r.walletBucket === "available" ||
      r.walletBucket === "coming" ||
      r.walletBucket === "reversed"
        ? round2((r.amount * deliveredPercent) / 100)
        : 0;

    return {
      ...r,
      incentivePercent: deliveredPercent,
      incentiveAmount,
    };
  });

  const availableRows = rows.filter((r) => r.walletBucket === "available");
  const upcomingRows = rows.filter(
    (r) => r.walletBucket === "coming" && !r.isAtRisk
  );
  const atRiskRows = rows.filter(
    (r) => r.walletBucket === "coming" && r.isAtRisk
  );
  const reversedRows = rows.filter((r) => r.walletBucket === "reversed");

  const availableIncentive = round2(
    availableRows.reduce((sum, r) => sum + Number(r.incentiveAmount || 0), 0)
  );

  const comingIncentive = round2(
    upcomingRows.reduce((sum, r) => sum + Number(r.incentiveAmount || 0), 0)
  );

  const reversedIncentive = round2(
    reversedRows.reduce((sum, r) => sum + Number(r.incentiveAmount || 0), 0)
  );

  const atRiskOrders = atRiskRows.length;
  const atRiskRevenue = round2(
    atRiskRows.reduce((sum, r) => sum + Number(r.amount || 0), 0)
  );
  const atRiskIncentive = round2(
    atRiskRows.reduce((sum, r) => sum + Number(r.incentiveAmount || 0), 0)
  );

  const upcomingOrders = upcomingRows.length;
  const upcomingRevenue = round2(
    upcomingRows.reduce((sum, r) => sum + Number(r.amount || 0), 0)
  );

  return {
    agentName,
    role,
    slab: {
      deliveredRevenue,
      deliveredPercent,
      totalRevenue,
      totalPercent,
      incentivePercent: deliveredPercent,
    },
    summary: {
      totalOrders: rows.length,
      deliveredOrders: availableRows.length,
      comingOrders: upcomingOrders,
      reversedOrders: reversedRows.length,
      unknownOrders: countByBucket(rows, "unknown"),

      deliveredRevenue,
      comingRevenue: upcomingRevenue,
      reversedRevenue,
      unknownRevenue,
      totalRevenue,

      availableIncentive,
      comingIncentive,
      reversedIncentive,

      atRiskOrders,
      atRiskRevenue,
      atRiskIncentive,

      totalVisibleIncentive: round2(availableIncentive + comingIncentive),
    },
    rows,
  };
}

async function buildVKRWalletData({
  agentName,
  startDate,
  endDate,
  employee,
  strictSop = false,
}) {
  const coinStartDate = getWalletCoinEffectiveStartDate(
    employee?.joiningDate,
    startDate
  );

  const emptyData = {
    agentName,
    role: employee?.role || "",
    sop: {
      name: VKR_WALLET_SOP_NAME,
      rewardType: "coin",
      valuePerCount: 0,
    },
    period: {
      startDate,
      endDate,
      effectiveStartDate: coinStartDate || startDate,
      joiningDate: employee?.joiningDate
        ? new Date(employee.joiningDate).toISOString().split("T")[0]
        : "",
      walletCoinStartDate: WALLET_COIN_START_DATE,
    },
    target: {
      dailyTarget: VKR_DAILY_TARGET,
      workingDays: 0,
      monthlyTargetCount: 0,
      deliveredCount: 0,
      achievementPercent: 0,
      minAchievementPercentToRetain: VKR_MIN_ACHIEVEMENT_PERCENT,
      status: "earned",
    },
    summary: {
      qualifyingOrders: 0,
      deliveredQualifyingOrders: 0,
      projectedCoins: 0,
      earnedCoins: 0,
      lapsedCoins: 0,
      baseProjectedCoins: 0,
      baseEarnedCoins: 0,
      prepaidCount: 0,
      partialPaidCount: 0,
      referralPatientCount: 0,
      prepaidCoins: 0,
      partialPaidCoins: 0,
      referralPatientCoins: 0,
      extraCoinsTotal: 0,
    },
    rules: {
      below60PercentTargetCoinsLapse: true,
      redeemableOnlyOnDiwali: true,
      redeemableOnlyTwiceAYear: ["May", "November"],
      cannotConvertToCash: true,
      ifMovedOutOrResignedNoPayout: true,
      coinCollectionStartsFrom: WALLET_COIN_START_DATE,
      cashCanConvertToCoin: true,
      coinCannotConvertToCash: true,
    },
    rows: [],
    note: `Wallet coins are counted only from ${WALLET_COIN_START_DATE}`,
  };

  if (!coinStartDate || coinStartDate > endDate) {
    return emptyData;
  }

  const sop = await SOP.findOne({
    name: VKR_WALLET_SOP_NAME,
    rewardType: "coin",
    isActive: true,
  }).lean();

  if (!sop) {
    if (strictSop) {
      const error = new Error(
        `Active SOP not found with name "${VKR_WALLET_SOP_NAME}"`
      );
      error.statusCode = 404;
      throw error;
    }
    return {
      ...emptyData,
      note: "VKR SOP not configured",
    };
  }

  const { startObj, endObj } = getDateRangeObjects(coinStartDate, endDate);

  let salesRows = [];

  if (employee.role === "Sales Agent") {
    const leadQuery = {
      agentAssigned: agentName,
      salesStatus: "Sales Done",
    };

    if (coinStartDate || endDate) {
      leadQuery.date = {};
      if (coinStartDate) leadQuery.date.$gte = coinStartDate;
      if (endDate) leadQuery.date.$lte = endDate;
    }

    const myOrderQuery = { agentName };
    if (startObj || endObj) {
      myOrderQuery.orderDate = {};
      if (startObj) myOrderQuery.orderDate.$gte = startObj;
      if (endObj) myOrderQuery.orderDate.$lte = endObj;
    }

    const [leads, myOrders] = await Promise.all([
      Lead.find(leadQuery).lean(),
      MyOrder.find(myOrderQuery).lean(),
    ]);

    salesRows = [
      ...leads.map((l) => ({
        source: "Lead",
        date: l.date || "",
        customerName: l.name || "",
        phone: l.contactNumber || "",
        contactNumber: l.contactNumber || "",
        orderId: l.orderId || "",
        amount: vkrParseAmount(l.amountPaid),
        modeOfPayment: l.modeOfPayment || "",
        leadSource: l.leadSource || "",
        salesStatus: l.salesStatus || "",
      })),
      ...myOrders.map((o) => {
        const upsell = vkrParseAmount(o.upsellAmount);
        const total = vkrParseAmount(o.totalPrice);

        return {
          source: "MyOrder",
          date: o.orderDate ? new Date(o.orderDate).toISOString().split("T")[0] : "",
          customerName: o.customerName || "",
          phone: o.phone || "",
          contactNumber: o.phone || "",
          orderId: o.orderId || "",
          amount: upsell > 0 ? upsell : total,
          modeOfPayment: o.paymentMethod || "",
          leadSource: "",
          salesStatus: "",
        };
      }),
    ];
  } else if (employee.role === "Retention Agent") {
    const retentionQuery = {
      orderCreatedBy: agentName,
    };

    if (coinStartDate || endDate) {
      retentionQuery.date = {};
      if (coinStartDate) retentionQuery.date.$gte = coinStartDate;
      if (endDate) retentionQuery.date.$lte = endDate;
    }

    const myOrderQuery = { agentName };
    if (startObj || endObj) {
      myOrderQuery.orderDate = {};
      if (startObj) myOrderQuery.orderDate.$gte = startObj;
      if (endObj) myOrderQuery.orderDate.$lte = endObj;
    }

    const [retentionSales, myOrders] = await Promise.all([
      RetentionSales.find(retentionQuery).lean(),
      MyOrder.find(myOrderQuery).lean(),
    ]);

    salesRows = [
      ...retentionSales.map((r) => ({
        source: "RetentionSales",
        date: r.date || "",
        customerName: r.name || "",
        phone: r.contactNumber || "",
        contactNumber: r.contactNumber || "",
        orderId: r.orderId || "",
        amount: vkrParseAmount(r.amountPaid),
        modeOfPayment: r.modeOfPayment || "",
        leadSource: r.leadSource || "",
        salesStatus: r.salesStatus || "",
      })),
      ...myOrders.map((o) => {
        const upsell = vkrParseAmount(o.upsellAmount);
        const total = vkrParseAmount(o.totalPrice);

        return {
          source: "MyOrder",
          date: o.orderDate ? new Date(o.orderDate).toISOString().split("T")[0] : "",
          customerName: o.customerName || "",
          phone: o.phone || "",
          contactNumber: o.phone || "",
          orderId: o.orderId || "",
          amount: upsell > 0 ? upsell : total,
          modeOfPayment: o.paymentMethod || "",
          leadSource: "",
          salesStatus: "",
        };
      }),
    ];
  } else {
    const error = new Error(
      "VKR wallet is only supported for Sales Agent and Retention Agent"
    );
    error.statusCode = 400;
    throw error;
  }

  salesRows = dedupeSalesRowsByOrder(salesRows);

  const extraCoinSummary = buildExtraCoinSummary(salesRows);

  const orderIdVariants = new Set();
  const numericOrderIds = new Set();

  salesRows.forEach((row) => {
    const raw = String(row.orderId || "").trim();
    const clean = normalizeOrderIdLocal(raw);

    if (!clean) return;

    orderIdVariants.add(raw);
    orderIdVariants.add(clean);
    orderIdVariants.add(`#${clean}`);

    const asNum = Number(clean);
    if (Number.isFinite(asNum)) numericOrderIds.add(asNum);
  });

  const [shopifyOrders, orderDocs] = await Promise.all([
    ShopifyOrder.find({
      $or: [
        { orderName: { $in: [...orderIdVariants] } },
        { orderId: { $in: [...numericOrderIds] } },
      ],
    }).lean(),
    Order.find({
      order_id: { $in: [...orderIdVariants] },
    }).lean(),
  ]);

  const shopifyMap = new Map();
  shopifyOrders.forEach((order) => {
    const nameKey = normalizeOrderIdLocal(order.orderName);
    if (nameKey) shopifyMap.set(nameKey, order);

    const numericKey = String(order.orderId || "").trim();
    if (numericKey) shopifyMap.set(numericKey, order);
  });

  const shipmentMap = new Map();
  orderDocs.forEach((order) => {
    const key = normalizeOrderIdLocal(order.order_id);
    if (key) shipmentMap.set(key, order.shipment_status || "");
  });

  const qualifyingRows = salesRows
    .map((saleRow) => {
      const cleanOrderId = normalizeOrderIdLocal(saleRow.orderId);
      const shopifyOrder = shopifyMap.get(cleanOrderId);

      if (!shopifyOrder) return null;

      const vkrCount = getVKRCountFromProducts(shopifyOrder.productsOrdered || []);
      if (!vkrCount) return null;

      const shipmentStatus = shipmentMap.get(cleanOrderId) || "";
      const isDelivered = isDeliveredShipmentStatus(shipmentStatus);

      return {
        date:
          shopifyOrder.orderDate
            ? new Date(shopifyOrder.orderDate).toISOString().split("T")[0]
            : saleRow.date || "",
        orderId: shopifyOrder.orderName || saleRow.orderId || "",
        customerName:
          shopifyOrder.customerName || saleRow.customerName || "",
        contactNumber:
          shopifyOrder.normalizedPhone ||
          shopifyOrder.contactNumber ||
          saleRow.phone ||
          "",
        shipmentStatus,
        vkrCount,
        isDelivered,
        coinsIfDelivered: vkrRound2(vkrCount * Number(sop.value || 0)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

    const { monthStart, monthEnd } = getCurrentMonthRange();


  const workingDays = countWorkingDaysExcludingSundays(
    monthStart,
    monthEnd
  );

  const monthlyTargetCount = workingDays * VKR_DAILY_TARGET;

  const deliveredRows = qualifyingRows.filter((row) => row.isDelivered);
  const deliveredCount = deliveredRows.reduce(
    (sum, row) => sum + Number(row.vkrCount || 0),
    0
  );

  const achievementPercent =
    monthlyTargetCount > 0
      ? vkrRound2((deliveredCount / monthlyTargetCount) * 100)
      : 0;

  const baseProjectedCoins = vkrRound2(deliveredCount * Number(sop.value || 0));
  const coinsLapsed = achievementPercent < VKR_MIN_ACHIEVEMENT_PERCENT;
  const baseEarnedCoins = coinsLapsed ? 0 : baseProjectedCoins;
  const lapsedCoins = coinsLapsed ? baseProjectedCoins : 0;

  const projectedCoins = vkrRound2(
    baseProjectedCoins + Number(extraCoinSummary.totalExtraCoins || 0)
  );

  const earnedCoins = vkrRound2(
    baseEarnedCoins + Number(extraCoinSummary.totalExtraCoins || 0)
  );

  return {
    agentName,
    role: employee.role,
    sop: {
      name: sop.name,
      rewardType: sop.rewardType,
      valuePerCount: Number(sop.value || 0),
    },
    period: {
      startDate,
      endDate,
      effectiveStartDate: coinStartDate,
      joiningDate: employee.joiningDate
        ? new Date(employee.joiningDate).toISOString().split("T")[0]
        : "",
      walletCoinStartDate: WALLET_COIN_START_DATE,
    },
    target: {
      dailyTarget: VKR_DAILY_TARGET,
      workingDays,
      monthlyTargetCount,
      deliveredCount,
      achievementPercent,
      minAchievementPercentToRetain: VKR_MIN_ACHIEVEMENT_PERCENT,
      status: coinsLapsed ? "lapsed" : "earned",
    },
    summary: {
      qualifyingOrders: qualifyingRows.length,
      deliveredQualifyingOrders: deliveredRows.length,

      baseProjectedCoins,
      baseEarnedCoins,

      projectedCoins,
      earnedCoins,
      lapsedCoins,

      prepaidCount: extraCoinSummary.prepaidCount,
      partialPaidCount: extraCoinSummary.partialPaidCount,
      referralPatientCount: extraCoinSummary.referralPatientCount,

      prepaidCoins: extraCoinSummary.prepaidCoins,
      partialPaidCoins: extraCoinSummary.partialPaidCoins,
      referralPatientCoins: extraCoinSummary.referralPatientCoins,
      extraCoinsTotal: extraCoinSummary.totalExtraCoins,
    },
    rules: {
      below60PercentTargetCoinsLapse: true,
      redeemableOnlyOnDiwali: true,
      redeemableOnlyTwiceAYear: ["May", "November"],
      cannotConvertToCash: true,
      ifMovedOutOrResignedNoPayout: true,
      coinCollectionStartsFrom: WALLET_COIN_START_DATE,
      cashCanConvertToCoin: true,
      coinCannotConvertToCash: true,
    },
    rows: qualifyingRows,
    note: `Wallet coins counted from ${WALLET_COIN_START_DATE}`,
  };
}

function applyCashToCoinConversions({
  cashData,
  walletCoinData,
  conversionSummary,
  redemptionSummary,
}) {
  const totalCashConverted = Number(conversionSummary?.totalCashConverted || 0);
  const totalCoinReceived = Number(conversionSummary?.totalCoinReceived || 0);
  const totalCoinRedeemed = Number(redemptionSummary?.totalCoinRedeemed || 0);

  const adjustedAvailableCash = round2(
    Math.max(
      0,
      Number(cashData.summary.availableIncentive || 0) - totalCashConverted
    )
  );

  const availableWalletCoin = round2(
    Math.max(
      0,
      Number(walletCoinData?.summary?.earnedCoins || 0) +
        totalCoinReceived -
        totalCoinRedeemed
    )
  );

  return {
    ...cashData,
    summary: {
      ...cashData.summary,
      rawAvailableIncentive: Number(cashData.summary.availableIncentive || 0),
      availableIncentive: adjustedAvailableCash,
      totalCashConverted,
      totalCoinReceived,
      totalCoinRedeemed,
      availableWalletCoin,
      convertedCoinAdded: totalCoinReceived,

      walletCoin: Number(walletCoinData?.summary?.earnedCoins || 0),
      walletCoinProjected: Number(walletCoinData?.summary?.projectedCoins || 0),
      walletCoinLapsed: Number(walletCoinData?.summary?.lapsedCoins || 0),
      walletCoinQualifyingOrders:
        Number(walletCoinData?.summary?.qualifyingOrders || 0),
      walletCoinDeliveredOrders:
        Number(walletCoinData?.summary?.deliveredQualifyingOrders || 0),
      walletCoinNote:
        walletCoinData?.note || `Coins counted from ${WALLET_COIN_START_DATE}`,

      prepaidCount: Number(walletCoinData?.summary?.prepaidCount || 0),
      partialPaidCount: Number(walletCoinData?.summary?.partialPaidCount || 0),
      referralPatientCount: Number(walletCoinData?.summary?.referralPatientCount || 0),

      prepaidCoins: Number(walletCoinData?.summary?.prepaidCoins || 0),
      partialPaidCoins: Number(walletCoinData?.summary?.partialPaidCoins || 0),
      referralPatientCoins: Number(walletCoinData?.summary?.referralPatientCoins || 0),

      walletCoinBaseEarned: Number(walletCoinData?.summary?.baseEarnedCoins || 0),
      walletCoinBaseProjected: Number(walletCoinData?.summary?.baseProjectedCoins || 0),
    },
    wallet: {
      availableCash: adjustedAvailableCash,
      availableCoin: availableWalletCoin,
      totalCashConverted,
      totalCoinReceived,
      totalCoinRedeemed,
    },
    walletCoin: walletCoinData
      ? {
          ...walletCoinData.summary,
          note: walletCoinData.note,
          sop: walletCoinData.sop,
          target: walletCoinData.target,
          period: walletCoinData.period,
          rows: walletCoinData.rows || [],
          rules: walletCoinData.rules || {},
          convertedCoinAdded: totalCoinReceived,
          totalCoinRedeemed,
          availableCoin: availableWalletCoin,
        }
      : {
          projectedCoins: 0,
          earnedCoins: 0,
          lapsedCoins: 0,
          qualifyingOrders: 0,
          deliveredQualifyingOrders: 0,
          baseEarnedCoins: 0,
          baseProjectedCoins: 0,

          prepaidCount: 0,
          partialPaidCount: 0,
          referralPatientCount: 0,

          prepaidCoins: 0,
          partialPaidCoins: 0,
          referralPatientCoins: 0,
          extraCoinsTotal: 0,

          note: `Wallet coins counted from ${WALLET_COIN_START_DATE}`,
          rows: [],
          rules: {
            coinCollectionStartsFrom: WALLET_COIN_START_DATE,
            cashCanConvertToCoin: true,
            coinCannotConvertToCash: true,
          },
          convertedCoinAdded: totalCoinReceived,
          totalCoinRedeemed,
          availableCoin: round2(Math.max(0, totalCoinReceived - totalCoinRedeemed)),
        },
  };
}

router.get("/api/incentives-new", requireSession, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    let { agentName, startDate, endDate } = req.query;

    if (hasFullAccess(sessionUser)) {
      if (!agentName) {
        return res.status(400).json({ message: "agentName is required" });
      }
    } else {
      agentName = sessionUser.fullName || "";
      if (!agentName) {
        return res.status(403).json({ message: "Agent scope not found in session" });
      }
    }

    const employee = await Employee.findOne(
      { fullName: agentName },
      { role: 1, joiningDate: 1 }
    ).lean();

    if (!employee) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const cashData = await buildCashWalletData({
      agentName,
      startDate,
      endDate,
      employee,
    });

    let walletCoinData = null;
    try {
      walletCoinData = await buildVKRWalletData({
        agentName,
        startDate,
        endDate,
        employee,
        strictSop: false,
      });
    } catch (walletErr) {
      console.error("Error building wallet coin inside /api/incentives-new:", walletErr);
      walletCoinData = null;
    }

    const conversionSummary = await getCashToCoinConversionSummary({
      agentName,
      startDate,
      endDate,
    });

    const redemptionSummary = await getWalletCoinRedemptionSummary({
      agentName,
      startDate,
      endDate,
    });

    const merged = applyCashToCoinConversions({
      cashData,
      walletCoinData,
      conversionSummary,
      redemptionSummary,
    });

    return res.json(merged);
  } catch (error) {
    console.error("Error in /api/incentives-new:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to fetch incentive data",
      error: error.message,
    });
  }
});

router.get("/api/vkr-wallet-coins", requireSession, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    let { agentName, startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required",
      });
    }

    if (hasFullAccess(sessionUser)) {
      if (!agentName) {
        return res.status(400).json({ message: "agentName is required" });
      }
    } else {
      agentName = sessionUser.fullName || "";
      if (!agentName) {
        return res.status(403).json({ message: "Agent scope not found in session" });
      }
    }

    const employee = await Employee.findOne(
      { fullName: agentName },
      { fullName: 1, role: 1, joiningDate: 1, status: 1, hasTeam: 1 }
    ).lean();

    if (!employee) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const data = await buildVKRWalletData({
      agentName,
      startDate,
      endDate,
      employee,
      strictSop: true,
    });

    return res.json(data);
  } catch (error) {
    console.error("Error in /api/vkr-wallet-coins:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to fetch VKR wallet coins",
      error: error.message,
    });
  }
});

router.post("/api/wallet/convert-cash-to-coin", requireSession, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    let { agentName, startDate, endDate, cashAmount } = req.body || {};

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required",
      });
    }

    if (hasFullAccess(sessionUser)) {
      if (!agentName) {
        return res.status(400).json({ message: "agentName is required" });
      }
    } else {
      agentName = sessionUser.fullName || "";
      if (!agentName) {
        return res.status(403).json({ message: "Agent scope not found in session" });
      }
    }

    const amount = round2(Number(cashAmount || 0));
    if (!amount || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "cashAmount must be greater than 0" });
    }

    const employee = await Employee.findOne(
      { fullName: agentName },
      { _id: 1, fullName: 1, role: 1, joiningDate: 1 }
    ).lean();

    if (!employee) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const cashData = await buildCashWalletData({
      agentName,
      startDate,
      endDate,
      employee,
    });

    const existingConversionSummary = await getCashToCoinConversionSummary({
      agentName,
      startDate,
      endDate,
    });

    const netAvailableCash = round2(
      Math.max(
        0,
        Number(cashData.summary.availableIncentive || 0) -
          Number(existingConversionSummary.totalCashConverted || 0)
      )
    );

    if (amount > netAvailableCash) {
      return res.status(400).json({
        message: "Entered amount is greater than available cash",
      });
    }

    const coinAmount = round2(amount * CASH_TO_COIN_RATE);

    const conversion = await WalletCashToCoinConversion.create({
      agentName,
      employeeId: employee._id || null,
      role: employee.role || "",
      startDate,
      endDate,
      cashAmount: amount,
      coinAmount,
      conversionRate: CASH_TO_COIN_RATE,
      createdBy: sessionUser.fullName || sessionUser.email || "",
      createdByEmail: sessionUser.email || "",
      note: "Cash converted into coin from wallet",
    });

    const latestConversionSummary = await getCashToCoinConversionSummary({
      agentName,
      startDate,
      endDate,
    });

    const redemptionSummary = await getWalletCoinRedemptionSummary({
      agentName,
      startDate,
      endDate,
    });

    const walletCoinData = await buildVKRWalletData({
      agentName,
      startDate,
      endDate,
      employee,
      strictSop: false,
    });

    const merged = applyCashToCoinConversions({
      cashData,
      walletCoinData,
      conversionSummary: latestConversionSummary,
      redemptionSummary,
    });

    return res.json({
      message: "Cash converted into coin successfully",
      conversionId: conversion._id,
      convertedCash: amount,
      convertedCoin: coinAmount,
      conversionRate: CASH_TO_COIN_RATE,
      wallet: merged.wallet,
      availableCash: merged.wallet.availableCash,
      availableCoin: merged.wallet.availableCoin,
    });
  } catch (error) {
    console.error("Error in /api/wallet/convert-cash-to-coin:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to convert cash into coin",
      error: error.message,
    });
  }
});


module.exports = router;
