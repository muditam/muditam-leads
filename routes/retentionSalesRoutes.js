// routes/retentionSalesRoutes.js

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const router = express.Router();

const Lead = require('../models/Lead');

// Import the Order model (Shipway data)
const Order = require('../models/Order');
const MyOrder = require("../models/MyOrder");

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
 

/**
 * 2. Helper to normalize phone numbers
 */
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


/**
 * 3. GET: Fetch retention sales (lightweight)
 *    - If `orderCreatedBy` is provided, filter by it.
 *    - Otherwise, return all RetentionSales.
 */
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

/**
 * 4. POST: Add a new retention sale
 */
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
    const amountPaid = upsellAmount + partialPayment; // Updated Amount Paid calculation

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

/**
 * 6. DELETE: Delete a retention sale by ID
 */
// router.delete('/api/retention-sales/:id', async (req, res) => {
//   const { id } = req.params;
//   try {
//     const deletedSale = await RetentionSales.findByIdAndDelete(id);
//     if (!deletedSale) {
//       return res.status(404).json({ message: 'Sale not found' });
//     }
//     res.status(200).json({ message: 'Sale deleted successfully' });
//   } catch (error) {
//     console.error('Error deleting retention sale:', error);
//     res.status(500).json({ message: 'Error deleting retention sale', error });
//   }
// });

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


/**
 * 7. POST: Update Shopify matching (heavy processing)
 *    - Always re-check phone+date for each sale.
 *    - If matched, set orderId/shopify_amount/shipway_status.
 *    - If no match, blank them out.
 */
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
    // For RetentionSales the "date" field is stored as a string.
    // We assume that buildDateMatch returns an object like:
    // { date: { $gte: "YYYY-MM-DD", $lte: "YYYY-MM-DD" } }
    const retentionMatch = buildDateMatch(startDate, endDate);

    // Build a filter for MyOrder based on the orderDate field.
    // MyOrder.orderDate is stored as a Date so we must convert the string(s)
    // to Date objects and include the entire day for the end date.
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

    // Aggregate from RetentionSales collection.
    // We assume that each retention sales record has:
    // - "orderCreatedBy": the agent name,
    // - "amountPaid": the sales amount (as a string or number).
    // We output a standardized structure with:
    //   salesDone: 1 per record, totalSales: amountPaid converted to number.
    const aggregatedData = await RetentionSales.aggregate([
      { $match: retentionMatch },
      {
        $project: {
          orderCreatedBy: 1,
          salesDone: { $literal: 1 },
          amountPaid: { $toDouble: { $ifNull: ["$amountPaid", 0] } }
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
      // Use $unionWith to add MyOrder data into the pipeline.
      { 
        $unionWith: {
          coll: "myorders", // The collection name for MyOrder documents (Mongoose pluralizes it)
          pipeline: [
            { $match: myOrderMatch },
            {
              $project: {
                agentName: "$agentName",
                // Determine the effective "amountPaid":
                // Use upsellAmount if greater than zero; otherwise use totalPrice.
                salesDone: { $literal: 1 },
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
      // Now merge the two sets of results by grouping again on agentName.
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


/**
 * NEW Endpoint 2: Overall Shipment Status Summary
 * GET /api/retention-sales/shipment-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
/**
 * Endpoint 2: Overall Shipment Status Summary
 * GET /api/retention-sales/shipment-summary?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
router.get('/api/retention-sales/shipment-summary', async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    // For RetentionSales: build a match filter based on the string date field.
    const retentionMatch = buildDateMatch(startDate, endDate);

    // Pipeline for RetentionSales shipment data
    const retentionPipeline = [
      { $match: retentionMatch },
      {
        $group: {
          _id: "$shipway_status",
          count: { $sum: 1 },
          totalAmount: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } }
        }
      },
      {
        $project: {
          // If shipway_status is null or empty, label it as "Not available"
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

    // Build a match filter for MyOrder on the Date field.
    let myOrderMatch = {};
    if (startDate || endDate) {
      myOrderMatch.orderDate = {};
      if (startDate) myOrderMatch.orderDate.$gte = new Date(startDate);
      if (endDate) {
        const endObj = new Date(endDate);
        endObj.setHours(23, 59, 59, 999);
        myOrderMatch.orderDate.$lte = endObj;
      }
    }

    // Pipeline for MyOrder shipment data.
    // Here we normalize the orderId (remove a leading '#' if present),
    // then look up the corresponding Order document to get its shipment status.
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
          from: "orders", // make sure this collection name is correct!
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
          // Extract the shipment status from the looked-up orderDoc or default to "Not available"
          shipmentStatus: { $ifNull: ["$orderDoc.shipment_status", "Not available"] },
          // Determine the effective amountPaid: use upsellAmount if > 0, else use totalPrice.
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

    // Use $unionWith to combine the results from RetentionSales and MyOrder pipelines,
    // then group again by category (i.e. shipment status) to merge duplicate groups.
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

    // Compute the total count for percentage calculation.
    const totalCount = combinedAggregation.reduce((acc, curr) => acc + curr.count, 0);
    const result = combinedAggregation.map(item => ({
      category: item.category,
      count: item.count,
      totalAmount: item.totalAmount,
      percentage: totalCount ? ((item.count / totalCount) * 100).toFixed(2) : "0.00"
    }));

    // Optionally, you can add a "Total Orders" row at the beginning.
    const totalAmount = result.reduce((acc, curr) => acc + curr.totalAmount, 0);
    result.unshift({
      category: "Total Orders",
      count: totalCount,
      totalAmount: totalAmount,
      percentage: "100.00"
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Error in combined shipment summary aggregation:", error);
    res.status(500).json({ message: "Error aggregating shipment summary", error: error.message });
  }
});



/**
 * Endpoint 3: Agent-wise Shipment Status Summary
 * GET /api/retention-sales/shipment-summary/agent?agentName=AgentName&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
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
      (acc, sale) => acc + (sale.amountPaid ? Number(sale.amountPaid) : 0),
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
      const amountPaid = upsellAmount > 0 ? upsellAmount : totalPrice;
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
  // If dateStr is provided and has the correct length (e.g., "YYYY-MM-DD"), return it.
  // Otherwise, return today's date in "YYYY-MM-DD" format.
  if (dateStr && dateStr.length === 10) {
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
    const sDate = parseDateOrToday(req.query.startDate);
    const eDate = parseDateOrToday(req.query.endDate);

    // Count leads with no followup set
    const noFollowupSet = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      $or: [
        { rtNextFollowupDate: { $exists: false } },
        { rtNextFollowupDate: null },
        { rtNextFollowupDate: "" },
      ],
    });

    // Count leads where followup has been missed (rtNextFollowupDate < sDate)
    const followupMissed = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: { $lt: sDate }
    });

    // Count leads scheduled for followup today (rtNextFollowupDate === sDate)
    const followupToday = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: sDate
    });

    // Count leads scheduled for followup tomorrow (rtNextFollowupDate === eDate)
    const followupTomorrow = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: eDate
    });

    // Count leads scheduled for followup later (rtNextFollowupDate > eDate)
    const followupLater = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: { $gt: eDate }
    });

    // Count lost customers (retentionStatus equals "Lost")
    const lostCustomers = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      retentionStatus: "Lost"
    });

    res.json({
      noFollowupSet,
      followupMissed,
      followupToday,
      followupTomorrow,
      followupLater,
      lostCustomers
    });
  } catch (error) {
    console.error("Error fetching followup summary:", error);
    res.status(500).json({
      message: "Error fetching followup summary",
      error: error.message
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
      if (startDate) {
        retentionQuery.date.$gte = startDate;
      }
      if (endDate) {
        retentionQuery.date.$lte = endDate;
      }
    }
    const retentionSales = await RetentionSales.find(retentionQuery).lean();

    // ----------------------------
    // 2. Fetch MyOrders Data
    // ----------------------------
    const myOrderQuery = { agentName };
    if (startDate || endDate) {
      myOrderQuery.orderDate = {};
      if (startDate) {
        myOrderQuery.orderDate.$gte = new Date(startDate);
      }
      if (endDate) {
        const endDateObj = new Date(endDate);
        endDateObj.setHours(23, 59, 59, 999);
        myOrderQuery.orderDate.$lte = endDateObj;
      }
    }
    const myOrders = await MyOrder.find(myOrderQuery).lean();

    // Transform MyOrder documents into the same shape
    const transformedMyOrders = myOrders.map((order) => {
      const upsellAmount = Number(order.upsellAmount) || 0;
      const totalPrice = Number(order.totalPrice) || 0;
      const amountPaid = upsellAmount > 0 ? upsellAmount : totalPrice;
      return {
        date: order.orderDate
          ? new Date(order.orderDate).toISOString().split("T")[0]
          : "",
        shipway_status: order.shipway_status?.trim() || "Unknown",
        amountPaid,
      };
    });

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

    // Build the summary array
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

// Assuming you have express and Lead model imported



module.exports = router;
 