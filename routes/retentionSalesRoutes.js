// routes/retentionSalesRoutes.js

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const router = express.Router();

const Lead = require('../models/Lead');

// Import the Order model (Shipway data)
const Order = require('../models/Order');

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

const MyOrder = require("../models/MyOrder");
 

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
    const match = buildDateMatch(startDate, endDate);
    const aggregatedData = await RetentionSales.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$orderCreatedBy",
          salesDone: { $sum: 1 },
          totalSales: { $sum: { $toDouble: { $ifNull: ["$amountPaid", 0] } } }
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
    console.error("Error aggregating retention sales:", error);
    res.status(500).json({ message: "Error aggregating retention sales", error: error.message });
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
    // 1) Build the match query
    const match = buildDateMatch(startDate, endDate);

    // 2) Aggregate
    const aggregatedShipment = await RetentionSales.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$shipway_status",
          count: { $sum: 1 },
          totalAmount: {
            $sum: {
              $toDouble: {
                $ifNull: ["$amountPaid", 0]
              }
            }
          }
        }
      },
      {
        $project: {
          category: {
            $cond: [
              {
                $or: [
                  { $eq: ["$_id", null] },  // If shipway_status is null
                  { $eq: ["$_id", ""] }     // If shipway_status is an empty string
                ]
              },
              "Not available",
              "$_id"
            ]
          },
          count: 1,
          totalAmount: 1
        }
        
      }
    ]);

    // 3) Compute percentages
    const totalCount = aggregatedShipment.reduce((sum, item) => sum + item.count, 0);
    aggregatedShipment.forEach(item => {
      item.percentage =
        totalCount > 0 ? ((item.count / totalCount) * 100).toFixed(2) : "0.00";
    });

    // 4) Insert "Total Orders" row at the start
    const totalAmount = aggregatedShipment.reduce((sum, item) => sum + item.totalAmount, 0);
    aggregatedShipment.unshift({
      category: "Total Orders",
      count: totalCount,
      totalAmount,
      percentage: "100"
    });

    // Note: we do NOT force "Not available" if it doesn't exist

    res.status(200).json(aggregatedShipment);
  } catch (error) {
    console.error("Error aggregating shipment summary:", error);
    res.status(500).json({
      message: "Error aggregating shipment summary",
      error: error.message
    });
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
    // 1) Build the match query
    const match = {
      orderCreatedBy: agentName,
      ...buildDateMatch(startDate, endDate)
    };

    // 2) Aggregate
    const aggregatedAgentShipment = await RetentionSales.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$shipway_status",
          count: { $sum: 1 },
          totalAmount: {
            $sum: {
              $toDouble: {
                $ifNull: ["$amountPaid", 0]
              }
            }
          }
        }
      },
      {
        $project: {
          category: {
            $cond: [
              {
                $or: [
                  { $eq: ["$_id", null] },  // If shipway_status is null
                  { $eq: ["$_id", ""] }     // If shipway_status is an empty string
                ]
              },
              "Not available",
              "$_id"
            ]
          },
          count: 1,
          totalAmount: 1
        }        
      }
    ]);

    // 3) Compute percentages
    const totalCount = aggregatedAgentShipment.reduce(
      (sum, item) => sum + item.count,
      0
    );
    aggregatedAgentShipment.forEach(item => {
      item.percentage =
        totalCount > 0 ? ((item.count / totalCount) * 100).toFixed(2) : "0.00";
    });

    // 4) Insert "Total Orders" row at the start
    const totalAmount = aggregatedAgentShipment.reduce(
      (sum, item) => sum + item.totalAmount,
      0
    );
    aggregatedAgentShipment.unshift({
      category: "Total Orders",
      count: totalCount,
      totalAmount,
      percentage: "100"
    });

    // Note: we do NOT force "Not available" if it doesn't exist

    res.status(200).json(aggregatedAgentShipment);
  } catch (error) {
    console.error("Error aggregating agent shipment summary:", error);
    res.status(500).json({
      message: "Error aggregating agent shipment summary",
      error: error.message
    });
  }
});

function parseDateOrToday(dateStr) {
  if (!dateStr) {
    return new Date().toISOString().split("T")[0]; // fallback to "today"
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return new Date().toISOString().split("T")[0]; // fallback
  }
  return dateStr;
}

/**
 * GET /api/today-summary
 * Accepts: agentName, startDate, endDate
 * If startDate/endDate not provided, fallback to "today".
 */
router.get("/api/today-summary", async (req, res) => {
  try {
    const agentName = req.query.agentName;
    if (!agentName) {
      return res.status(400).json({ message: "agentName is required." });
    }
    // parse the date range or fallback to "today"
    const sDate = parseDateOrToday(req.query.startDate);
    const eDate = parseDateOrToday(req.query.endDate);

    // Convert sDate/eDate to actual Date objects
    const start = new Date(sDate);
    const end = new Date(eDate);
    // If you want the end date to be inclusive, set end to end-of-day
    end.setHours(23, 59, 59, 999);

    // For example, fetch "activeCustomers" from leads in the date range,
    // or just keep the logic you had. 
    // Suppose you want to consider all leads assigned to agentName 
    // that were "retentionStatus=Active" during that range, etc.
    // Or you can store creation date in leads if needed.
    // Example below simply counts "activeCustomers" ignoring date,
    // but you can adapt as needed.

    // 1) Active Customers
    const activeCustomers = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      $or: [
        { retentionStatus: { $exists: false } },
        { retentionStatus: "Active" }
      ]
    });

    // 2) fetch retention sales in that date range
    // The "date" field is in "YYYY-MM-DD" string form, so compare strings
    const retentionSales = await RetentionSales.find({
      orderCreatedBy: agentName,
      date: { $gte: sDate, $lte: eDate },
    });

    const salesDone = retentionSales.length;
    const totalSales = retentionSales.reduce(
      (acc, sale) => acc + (sale.amountPaid || 0),
      0
    );
    const avgOrderValue = salesDone > 0 ? totalSales / salesDone : 0;

    res.json({
      activeCustomers,
      salesDone,
      totalSales,
      avgOrderValue
    });
  } catch (error) {
    console.error("Error fetching today summary:", error);
    res.status(500).json({
      message: "Error fetching today summary",
      error: error.message
    });
  }
});

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

    // For your followup logic, you might check leads with 
    // rtNextFollowupDate between sDate and eDate, etc.
    // For example, if you want to count leads in that entire range:
    // or keep your existing logic if you only do "today", "tomorrow", etc.

    // Example: let's interpret sDate/eDate as the "window" for nextFollowup
    // So "noFollowupSet" is leads that have no nextFollowup 
    // but were assigned to agentName at all (no date filtering).
    // Adjust as you see fit if you want date-based filtering for followups.

    // Or you can do a simplified approach: if sDate/eDate is not "today", 
    // you can just interpret them as the "window" for nextFollowup. 
    // The code below is an example.

    // noFollowupSet
    const noFollowupSet = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      $or: [
        { rtNextFollowupDate: { $exists: false } },
        { rtNextFollowupDate: null },
        { rtNextFollowupDate: "" },
      ],
    });

    // followupMissed => leads with rtNextFollowupDate < sDate
    const followupMissed = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: { $lt: sDate }
    });

    // followupToday => leads with rtNextFollowupDate == sDate
    const followupToday = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: sDate
    });

    // followupTomorrow => leads with rtNextFollowupDate == eDate
    // (this is arbitrary if you want sDate/eDate logic)
    const followupTomorrow = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: eDate
    });

    // followupLater => leads with rtNextFollowupDate > eDate
    const followupLater = await Lead.countDocuments({
      healthExpertAssigned: agentName,
      rtNextFollowupDate: { $gt: eDate }
    });

    res.json({
      noFollowupSet,
      followupMissed,
      followupToday,
      followupTomorrow,
      followupLater
    });
  } catch (error) {
    console.error("Error fetching followup summary:", error);
    res.status(500).json({
      message: "Error fetching followup summary",
      error: error.message
    });
  }
});

router.get("/api/all-time-summary", async (req, res) => {
  try {
    const agentName = req.query.agentName;
    if (!agentName) {
      return res.status(400).json({ message: "Agent name is required." });
    }

    // Determine the current month's date range in "YYYY-MM-DD" format.
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .split("T")[0];
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .split("T")[0];

    // Run queries concurrently.
    const totalCustomersPromise = Lead.countDocuments({ healthExpertAssigned: agentName });
    const activeCustomersPromise = Lead.countDocuments({
      healthExpertAssigned: agentName,
      $or: [
        { retentionStatus: { $exists: false } },
        { retentionStatus: "Active" }
      ]
    });
    const lostCustomersPromise = Lead.countDocuments({
      healthExpertAssigned: agentName,
      retentionStatus: "Lost"
    });
    const retentionSalesPromise = RetentionSales.find({ orderCreatedBy: agentName });

    const [totalCustomers, activeCustomers, lostCustomers, retentionSales] = await Promise.all([
      totalCustomersPromise,
      activeCustomersPromise,
      lostCustomersPromise,
      retentionSalesPromise
    ]);

    // Compute metrics from retention sales.
    const salesDone = retentionSales.length;
    const totalSales = retentionSales.reduce((acc, sale) => acc + (sale.amountPaid || 0), 0);

    // Count sales done in the current month.
    const customersRetainedThisMonth = retentionSales.filter((sale) => {
      // Assuming sale.date is stored in "YYYY-MM-DD" format.
      return sale.date >= firstDayOfMonth && sale.date <= lastDayOfMonth;
    }).length;

    const retentionRate =
      totalCustomers > 0
        ? parseFloat(((customersRetainedThisMonth / totalCustomers) * 100).toFixed(2))
        : 0;
    const avgOrderValue =
      salesDone > 0 ? parseFloat((totalSales / salesDone).toFixed(2)) : 0;

    res.json({
      totalCustomers,
      activeCustomers,
      lostCustomers,
      customersRetainedThisMonth,
      retentionRate,
      salesDone,
      totalSales,
      avgOrderValue,
    });
  } catch (error) {
    console.error("Error fetching all time summary:", error);
    res.status(500).json({ message: "Error fetching all time summary", error: error.message });
  }
});

router.get("/api/shipment-summary", async (req, res) => {
  try {
    const { agentName, startDate, endDate } = req.query;
    if (!agentName) {
      return res.status(400).json({ message: "Agent name is required." });
    }

    // Retrieve all retention sales for the given agent.
    const sales = await RetentionSales.find({ orderCreatedBy: agentName });

    // Filter sales by date if startDate and/or endDate are provided.
    const filteredSales = sales.filter((sale) => {
      if (!sale.date) return false; // Skip if date is not available.
      if (startDate && sale.date < startDate) return false;
      if (endDate && sale.date > endDate) return false;
      return true;
    });

    const totalOrders = filteredSales.length;
    const totalAmount = filteredSales.reduce(
      (acc, sale) => acc + (sale.amountPaid || 0),
      0
    );

    // Group sales by shipment status.
    const statusMap = {};
    filteredSales.forEach((sale) => {
      const status = sale.shipway_status || "Unknown";
      if (!statusMap[status]) {
        statusMap[status] = { count: 0, amount: 0 };
      }
      statusMap[status].count += 1;
      statusMap[status].amount += sale.amountPaid || 0;
    });

    // Build summary array. Start with a "Total Orders" row.
    const summary = [
      {
        label: "Total Orders",
        count: totalOrders,
        amount: totalAmount,
        percentage: "100.00",
      },
    ];

    // For each shipment status, compute the percentage. 
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

    res.json(summary);
  } catch (error) {
    console.error("Error fetching shipment summary:", error);
    res.status(500).json({ message: "Error fetching shipment summary", error: error.message });
  }
});


router.get('/api/retention-sales/all', async (req, res) => {
  try {
    const { orderCreatedBy } = req.query;

    const retentionQuery = orderCreatedBy ? { orderCreatedBy } : {};
    const myOrderQuery = orderCreatedBy ? { agentName: orderCreatedBy } : {};

    // Fetch RetentionSales records as they already are
    const retentionSales = await RetentionSales.find(retentionQuery).lean();
    const myOrders = await MyOrder.find(myOrderQuery).lean();

    // Transform MyOrder records to match RetentionSales shape
    const transformedOrders = myOrders.map(order => {
      const upsellAmount = Number(order.upsellAmount);
      const partialPayment = Number(order.partialPayment);
      const totalPrice = Number(order.totalPrice);
      let amountPaid = upsellAmount > 0 ? upsellAmount : totalPrice;
      return { 
        _id: order._id, 
        date: order.orderDate ? new Date(order.orderDate).toISOString().split("T")[0] : "",
        name: order.customerName,
        contactNumber: order.phone,
        productsOrdered: order.productOrdered,
        dosageOrdered: order.dosageOrdered,
        upsellAmount: upsellAmount,  
        partialPayment: partialPayment,  
        amountPaid: amountPaid,  
        modeOfPayment: order.paymentMethod,  
        shipway_status: order.shipway_status || "",  
        orderId: order.orderId,
        orderCreatedBy: order.agentName,
        remarks: order.selfRemark || "", 
        source: "MyOrder"
      };
    });

    // Combine both arrays
    const combinedData = [...retentionSales, ...transformedOrders];

    // For each record with an orderId but missing shipment status, query the Order collection
    await Promise.all(
      combinedData.map(async (sale) => {
        if (sale.orderId && (!sale.shipway_status || sale.shipway_status.trim() === "")) {
          const normalizedOrderId = sale.orderId.startsWith('#') ? sale.orderId.slice(1) : sale.orderId;
          const orderRecord = await Order.findOne({ order_id: normalizedOrderId }).lean();
          if (orderRecord) {
            sale.shipway_status = orderRecord.shipment_status;
          }
        }
      })
    );

    combinedData.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json(combinedData);
  } catch (error) {
    console.error("Error fetching combined retention sales:", error);
    res.status(500).json({ message: "Error fetching combined retention sales", error: error.message });
  }
});

 

module.exports = router;
 