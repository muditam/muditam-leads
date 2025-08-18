require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose'); 
const dns = require('dns');
const cors = require('cors');
const multer = require("multer");
const path = require('path');
const Lead = require('./models/Lead');
const Customer = require('./models/Customer');
const ConsultationDetails = require('./models/ConsultationDetails');  
const XLSX = require("xlsx");
const axios = require('axios');
const https = require('https');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const TransferRequest = require('./models/TransferRequests');
const shopifyProductsRoute = require("./services/shopifyProducts"); 
const shopifyOrdersRoute = require("./services/shopifyOrders");
const ShopifyPush = require("./services/ShopifyPush");
const razorpayRoutes = require("./services/razorpay");
const shopifyRoutes = require("./routes/shopifyRoutes"); 
const templateRoutes = require("./routes/templates");
const exportLeadsRouter = require('./routes/exportLeads');
const retentionSalesRoutes = require('./routes/retentionSalesRoutes');
const activeCountsRoute = require("./routes/activeCountsRoute"); 
const summaryRoutes = require('./routes/summaryRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const myOrdersRoutes = require("./routes/myOrders");
const Order = require('./models/Order');
const MyOrder = require('./models/MyOrder');
const Employee = require('./models/Employee');
const orderByIdRoutes = require("./routes/orderById");
const combinedOrdersRoute = require("./routes/combinedOrders");
const customerRoutes = require("./routes/customerRoutes");
const consultationDetailsRoutes = require("./routes/consultationDetailsRoutes");
const consultationProxyRoutes = require("./routes/consultationProxy");
const consultationFullHistoryRoute = require("./routes/consultationFullHistory");  
const consultationFollowupRoute = require("./routes/consultationFollowup");
const duplicateNumbersRoutes = require("./routes/duplicateNumbersRoutes");
const ordersDatesRoute = require("./routes/orders-dates");
const uploadToWasabi = require("./routes/uploadToWasabi");
const detailsRoutes = require("./routes/details");
const escalationRoutes = require('./routes/escalation.routes');
const orderRoutes = require("./routes/orderRoutes");
const getActiveProductsRoute = require("./routes/getActiveProducts");
const phonepeRoutes = require('./routes/phonepePaymentLink');
const downloadRoute = require('./routes/download');
const deliveryStatusRoutes = require("./routes/deliverystatuschecker");
const mergedSalesRoutes = require("./routes/mergedSales");
const employeeRoutes = require("./routes/employees");
const shipwayRoutes = require('./routes/shipwayRoutes');
const reachoutRoutes = require('./routes/reachoutLogs');
const leadTransfer = require('./routes/leadTransferRoutes');
const searchRoutes = require('./routes/searchRoutes');
const Addemployee = require('./routes/Addemployee');
const authRoutes = require('./routes/loginRoutes');
const clickToCallRoutes = require('./routes/clickToCallRoutes');
const financeRoutes = require("./routes/financeRoutes");
const razorpaySettlementRoutes = require("./PaymentGateway/razorpaySettlements");
const GokwikSettlementRoutes = require("./PaymentGateway/easebuzz");
const phonepeFinance = require("./PaymentGateway/phonepeFinance");
const Bluedart = require("./PaymentGateway/bluedart");
const Delhivery = require("./PaymentGateway/delhivery");
const DTDC = require("./PaymentGateway/DTDC");
const OrderSummeryOperations = require('./operations/OrderSummeryOperations');

const markRTORoute = require("./operations/markRTO");
const AbandonedCheckout = require('./models/AbandonedCheckout');
const abandonedRouter = require('./routes/abandoned'); 

const app = express();
const PORT = process.env.PORT || 5001; 

const allowedOrigins = ['https://www.60brands.com', 'http://localhost:3000'];

dns.setServers(['8.8.8.8', '1.1.1.1']);

const rawSaver = (req, res, buf) => { req.rawBody = buf; };

app.use(cors({
  origin: function (origin, callback) { 
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('Not allowed by CORS')); 
    }
    return callback(null, true); 
  } 
}));
 
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization"); 
  next();
});

app.use(express.json());

app.use("/api/templates", templateRoutes);
app.use("/api/shopify", shopifyProductsRoute);
app.use("/api/shopify", shopifyOrdersRoute);
app.use("/api/shopify", ShopifyPush);
app.use("/api/razorpay", razorpayRoutes);
app.use("/api/shopify", shopifyRoutes);
app.use("/api/my-orders", myOrdersRoutes); 

app.use(retentionSalesRoutes);

app.use('/', exportLeadsRouter);
 
app.use("/api/leads/retention", activeCountsRoute);
 
app.use('/api', summaryRoutes);
 
app.use('/api/dashboard', dashboardRoutes);

app.use("/api/order-by-id", orderByIdRoutes);

app.use("/api/orders/combined", combinedOrdersRoute);
 
app.use(customerRoutes);
 
app.use("/api/consultation-details", consultationDetailsRoutes);

app.use("/", consultationProxyRoutes);
 
app.use("/api/consultation-full-history", consultationFullHistoryRoute);
 
app.use("/api/consultation-followup", consultationFollowupRoute);
 
app.use("/api/leads", duplicateNumbersRoutes);
app.use("/api/duplicate-leads", duplicateNumbersRoutes);

app.use(ordersDatesRoute);

app.use(uploadToWasabi);

app.use("/api/details", detailsRoutes);

app.use('/api/escalations', escalationRoutes);

app.use("/api/orders", orderRoutes);

app.use(getActiveProductsRoute);

app.use('/api/phonepe', phonepeRoutes);

app.use('/api/myorders/download', downloadRoute);

app.use("/api/delivery", deliveryStatusRoutes);

app.use("/api/merged-sales", mergedSalesRoutes);

app.use("/api/deliver-history", employeeRoutes);

app.use('/api/shipway', shipwayRoutes);

app.use('/api/reachout-logs', reachoutRoutes);

app.use('/api/leads', leadTransfer);

app.use('/api/search', searchRoutes); 

app.use(Addemployee);

app.use('/api', authRoutes);

app.use('/api', clickToCallRoutes);

app.use("/api/finance", financeRoutes);

app.use("/api/razorpay", razorpaySettlementRoutes);

app.use("/api/easebuzz", GokwikSettlementRoutes);

app.use("/api/phonepe", phonepeFinance);

app.use("/api/bluedart", Bluedart);

app.use("/api/delhivery", Delhivery);

app.use("/api/dtdc", DTDC); 

app.use('/api/operations', OrderSummeryOperations);

app.use(markRTORoute);

app.use("/api/abandoned", abandonedRouter);

mongoose.connect(process.env.MONGO_URI, { 
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err)); 


const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  secureProtocol: 'TLSv1_2_method'
});


app.post(
  "/api/webhook",
  bodyParser.json({ verify: rawSaver, limit: "2mb", type: ["application/json", "application/cloudevents+json", "text/json"] }),
  bodyParser.urlencoded({ verify: rawSaver, extended: false, limit: "2mb", type: ["application/x-www-form-urlencoded"] }),
  bodyParser.text({ verify: rawSaver, type: ["text/plain"], limit: "2mb" }),
  async (req, res) => {
    try {
      const ctype = (req.headers["content-type"] || "").split(";")[0];
      const raw = req.rawBody || Buffer.from("");

      // ---- Optional HMAC verification ----
      const sharedSecret = process.env.GOKWIK_WEBHOOK_SECRET;
      const sig = req.get("X-GK-Signature") || req.get("x-gk-signature");
      if (sharedSecret && sig) {
        const digest = require("crypto").createHmac("sha256", sharedSecret).update(raw).digest("hex");
        const ok = sig.replace(/^sha256=/, "") === digest;
        if (!ok) return res.status(401).send("Invalid signature");
      }

      // ---- Parse body into `event` ----
      let event;
      if (ctype === "application/json" || ctype === "application/cloudevents+json" || ctype === "text/json") {
        event = req.body;
      } else if (ctype === "application/x-www-form-urlencoded") {
        const params = req.body;
        if (typeof params.payload === "string") {
          try { event = JSON.parse(params.payload); } catch { event = params; }
        } else {
          event = params;
        }
      } else if (ctype === "text/plain") {
        const str = typeof req.body === "string" ? req.body : raw.toString("utf8");
        try { event = JSON.parse(str); } catch { event = { text: str }; }
      } else {
        try { event = JSON.parse(raw.toString("utf8")); }
        catch {
          console.error("Unsupported Content-Type or non-JSON body:", {
            contentType: ctype,
            bodyPreview: raw.toString("utf8").slice(0, 500),
          });
          return res.status(400).send("Unsupported body format");
        }
      }

      // Some providers wrap actual data under .data or .payload
      const root = event?.data || event?.payload || event;

      // CloudEvents fallbacks for ID/type/time
      const ceType = req.get("ce-type") || req.get("Ce-Type");
      const ceId = req.get("ce-id") || req.get("Ce-Id");
      const ceTime = req.get("ce-time") || req.get("Ce-Time");

      const typeRaw =
        (event.type || event.event || event.topic || event.event_type || ceType || "").toString().toLowerCase();

      // broader detection of "abandoned" events
      const maybeAbandoned =
        /abandon/.test(typeRaw) ||
        /abandon/.test(String(event.name || event.event_name || "")) ||
        root?.status === "abandoned" ||
        root?.abandoned === true;

      // Build a robust eventId/checkoutId/orderId set
      const eventId =
        event.id || event.event_id || root?.event_id || root?.id || ceId || root?.checkout_id || root?.order_id;

      const checkoutId = root?.checkout_id || root?.cart_id || root?.checkoutId || root?.checkout_token;
      const orderId = root?.order_id || root?.orderId;

      // Customer
      const cust = root.customer || root.user || root.billing_address || root.contact || {};
      const customer = {
        name:
          cust.name ||
          [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim() ||
          root.name ||
          "",
        email: cust.email || root.email || "",
        phone: cust.phone || cust.mobile || root.phone || "",
      };

      // Items array from various shapes
      const itemsSrc =
        (Array.isArray(root.line_items) && root.line_items) ||
        (Array.isArray(root.items) && root.items) ||
        (root.cart && Array.isArray(root.cart.items) && root.cart.items) ||
        (root.order && Array.isArray(root.order.line_items) && root.order.line_items) ||
        [];

      const safeNum = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));

      const items = itemsSrc.map((it) => {
        const qty = safeNum(it.quantity ?? it.qty ?? it.count) ?? 1;

        // best guess for unit & final line price across platforms
        const unitPrice =
          safeNum(it.final_price_per_unit) ??
          safeNum(it.discounted_price_per_unit) ??
          safeNum(it.unit_price) ??
          safeNum(it.price) ??
          safeNum(it.original_price) ??
          0;

        const providedLine =
          safeNum(it.final_line_price) ??
          safeNum(it.line_price_final) ??
          safeNum(it.discounted_total_price) ??
          safeNum(it.price_total) ??
          safeNum(it.line_price) ??
          safeNum(it.total);

        const finalLinePrice = providedLine ?? unitPrice * qty;

        const variantTitle =
          it.variant_title ||
          it.variant ||
          [it.option1, it.option2, it.option3].filter(Boolean).join(" / ") ||
          "";

        return {
          sku: it.sku || it.variant_sku || it.id || "",
          title: it.title || it.name || it.product_name || "",
          variantTitle,
          quantity: qty,
          unitPrice,
          finalLinePrice,
        };
      });

      // Currency + total (fallback to sum of line totals if missing)
      const currency = root.currency || root.cart?.currency || root.currency_code || "INR";

      const totalProvided =
        safeNum(root.total) ??
        safeNum(root.total_price) ??
        safeNum(root.amount) ??
        safeNum(root.grand_total) ??
        safeNum(event.amount);

      const total = totalProvided ?? items.reduce((s, it) => s + (it.finalLinePrice || 0), 0);

      // Event time
      const eventAt =
        (root.created_at && new Date(root.created_at)) ||
        (event.timestamp && new Date(event.timestamp)) ||
        (ceTime && new Date(ceTime)) ||
        new Date();

      const normalized = {
        eventId,
        checkoutId,
        orderId,
        type: typeRaw || "abandoned_checkout",
        customer,
        items,
        itemCount: items.length,
        currency,
        total,
        eventAt,
        receivedAt: new Date(),
        raw: event,
      };

      console.log("✅ Webhook received:", {
        eventId: normalized.eventId,
        type: normalized.type,
        itemCount: normalized.itemCount,
        total: normalized.total,
        customerEmail: normalized.customer.email,
        customerPhone: normalized.customer.phone,
      });

      // Persist if abandoned or looks like it
      if (maybeAbandoned) {
        const query = normalized.eventId
          ? { eventId: normalized.eventId }
          : (normalized.checkoutId
              ? { checkoutId: normalized.checkoutId, eventAt: { $gte: new Date(normalized.eventAt.getTime() - 5 * 60 * 1000) } } // 5-min window
              : { type: normalized.type, "customer.phone": normalized.customer.phone, eventAt: { $gte: new Date(normalized.eventAt.getTime() - 5 * 60 * 1000) } }
            );

        await AbandonedCheckout.findOneAndUpdate(
          query,
          { $setOnInsert: normalized },
          { upsert: true, new: true }
        );
      }

      return res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).send("server error");
    }
  }
);

async function fetchAllOrders(url, accessToken, allOrders = []) {
  try {
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      httpsAgent: httpsAgent
    });

    if (!response.data.orders) {
      console.error("No orders found in response:", response.data);
      return allOrders;
    }

    const fetchedOrders = response.data.orders.map(order => {
      let phone = '';
      if (order.customer && order.customer.default_address && order.customer.default_address.phone) {
        phone = order.customer.default_address.phone.replace(/^\+91/, '').trim();
      } else {
        console.warn(`Order ${order.id} is missing customer phone or address.`);
      }

      return {
        order_id: order.name,
        name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
        contact_number: phone,
        created_at: order.created_at,
        total_price: order.total_price,
        payment_gateway_names: order.payment_gateway_names,
        line_items: order.line_items,
        channel_name: order.source_name || 'Unknown',
        delivery_status: order.fulfillment_status || 'Not Specified'
      };
    });

    allOrders = allOrders.concat(fetchedOrders);

    const nextLink = response.headers.link &&
      response.headers.link
        .split(',')
        .filter(s => s.includes('rel="next"'))
        .map(s => s.match(/<(.*)>; rel="next"/))
        .find(Boolean);

    if (nextLink && nextLink[1]) {
      return fetchAllOrders(nextLink[1], accessToken, allOrders);
    }

    return allOrders;
  } catch (error) {
    console.error('Failed to fetch orders:', error.response ? error.response.data : error.message);
    throw error;
  }
}

app.get('/api/orders', async (req, res) => {
  const { startDate, endDate } = req.query;

  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    return res.status(400).send("Invalid date range: startDate cannot be after endDate.");
  }

  const defaultStartDate = "2025-02-01T00:00:00Z";
  const defaultEndDate = new Date().toISOString();

  const startDateObj = startDate ? new Date(startDate) : new Date(defaultStartDate);
  startDateObj.setHours(0, 0, 0, 0);
  const start = startDateObj.toISOString();

  const endDateObj = endDate ? new Date(endDate) : new Date(defaultEndDate);
  endDateObj.setHours(23, 59, 59, 999);
  const end = endDateObj.toISOString();

  const startEncoded = encodeURIComponent(start);
  const endEncoded = encodeURIComponent(end);

  const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=${startEncoded}&created_at_max=${endEncoded}&limit=250`;

  try {
    const orders = await fetchAllOrders(shopifyAPIEndpoint, process.env.SHOPIFY_API_SECRET);

    const ordersWithShipwayStatus = await Promise.all(
      orders.map(async (order) => {
        const normalizedOrderId = order.order_id.startsWith('#')
          ? order.order_id.slice(1)
          : order.order_id;
        const shipwayOrder = await Order.findOne({ order_id: normalizedOrderId });
        order.shipway_status = shipwayOrder ? shipwayOrder.shipment_status : "Not available";
        return order;
      })
    );

    res.json(ordersWithShipwayStatus);
  } catch (error) {
    console.error('Error fetching orders from Shopify:', error.response ? error.response.data : error.message);
    res.status(500).send('Failed to fetch orders');
  }
});


const statusMapping = {
  "DEL": "Delivered",
  "INT": "In Transit",
  "UND": "Undelivered",
  "RTO": "RTO",
  "RTD": "RTO Delivered",
  "CAN": "Canceled",
  "SCH": "Shipment Booked",
  "ONH": "On Hold",
  "OOD": "Out For Delivery",
  "NFI": "Status Pending",
  "NFIDS": "NFID",
  "RSCH": "Pickup Scheduled",
  "ROOP": "Out for Pickup",
  "RPKP": "Shipment Picked Up",
  "RDEL": "Return Delivered",
  "RINT": "Return In Transit",
  "RPSH": "Pickup Rescheduled",
  "RCAN": "Return Request Cancelled",
  "RCLO": "Return Request Closed",
  "RSMD": "Pickup Delayed",
  "PCAN": "Pickup Cancelled",
  "ROTH": "Others",
  "RPF": "Pickup Failed"
};

const fetchOrdersFromShipway = async (page, startDate, endDate) => {
  const username = process.env.SHIPWAY_USERNAME;
  const licenseKey = process.env.SHIPWAY_LICENSE_KEY;
  const authHeader = `Basic ${Buffer.from(`${username}:${licenseKey}`).toString('base64')}`;

  const params = { page, startDate, endDate };

  const response = await axios.get("https://app.shipway.com/api/getorders", {
    headers: { Authorization: authHeader },
    params
  });

  return response.data.message;
};

const syncOrdersForDateRange = async (startDate, endDate) => {
  console.log(`Starting sync of Shipway orders from ${startDate} to ${endDate}...`);
  let page = 1;
  let totalFetched = 0;
  const rowsPerPage = 100;

  while (true) {
    try {
      const orders = await fetchOrdersFromShipway(page, startDate, endDate);
      if (!orders || orders.length === 0) {
        console.log(`No more orders found on page ${page}. Exiting loop.`);
        break;
      }

      console.log(`Fetched ${orders.length} orders on page ${page}. Processing...`);

      for (const order of orders) {
        const normalizedOrderId = order.order_id.replace(/^#/, '');
        const shipmentStatus = statusMapping[order.shipment_status] || order.shipment_status;
        const orderDate = order.order_date ? new Date(order.order_date) : null;

        const contactNumber = order.phone || order.s_phone || "";
        const trackingNumber = order.tracking_number || "";
        const carrierTitle = order.carrier_title || "";
        const fullName = [order.s_firstname, order.s_lastname].filter(Boolean).join(" ").trim();

        const updateFields = {
          order_id: normalizedOrderId,
          shipment_status: shipmentStatus,
          order_date: orderDate,
          tracking_number: trackingNumber,
          carrier_title: carrierTitle,
          full_name: fullName,
          last_updated_at: new Date()
        };

        if (contactNumber) {
          updateFields.contact_number = contactNumber;
          console.log(`Updating ${normalizedOrderId} with contact number: ${contactNumber}`);
        }

        if (trackingNumber) {
          console.log(`Updating ${normalizedOrderId} with tracking number: ${trackingNumber}`);
        }

        if (carrierTitle) {
          console.log(`Updating ${normalizedOrderId} with carrier: ${carrierTitle}`);
        }

        if (fullName) {
          console.log(`Updating ${normalizedOrderId} with full name: ${fullName}`);
        }

        const existing = await Order.findOne({ order_id: normalizedOrderId });
        if (existing && existing.selfUpdated) {
          console.log(`Skipping ${normalizedOrderId} — marked as selfUpdated`);
          continue;
        }

        const updateResult = await Order.updateOne(
          { order_id: normalizedOrderId },
          { $set: updateFields },
          { upsert: true }
        );

        console.log(`Order ${normalizedOrderId} updated. Mongo result:`, updateResult);
      }

      totalFetched += orders.length;

      if (orders.length < rowsPerPage) {
        console.log(`Fetched last page (${page}). Total orders processed: ${totalFetched}`);
        break;
      }

      page++;
    } catch (error) {
      console.error(`Error during syncOrdersForDateRange on page ${page}:`, error);
      break;
    }
  }

  console.log(`Completed syncOrdersForDateRange. Total orders fetched and updated: ${totalFetched}`);
  return totalFetched;
};


// POST /api/leads/by-phones
app.post('/api/leads/by-phones', async (req, res) => {
  const { phoneNumbers } = req.body;
  if (!Array.isArray(phoneNumbers)) {
    return res.status(400).json({ message: 'phoneNumbers should be an array' });
  }

  const cleanedPhones = phoneNumbers.map((phone) => phone.replace(/[^\d]/g, ""));
  try {
    const leads = await Lead.find({
      contactNumber: { $in: cleanedPhones },
    });

    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});


app.post('/api/shipway/fetch-orders', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "Missing startDate or endDate in request body" });
    }
    const totalFetched = await syncOrdersForDateRange(startDate, endDate);
    res.json({ message: `Fetched and stored ${totalFetched} orders for date range ${startDate} to ${endDate}` });
  } catch (error) {
    res.status(500).json({ message: "Error fetching orders", error: error.message });
  }
});

app.get('/api/shipway/orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const rowsPerPage = 100;
    const skip = (page - 1) * rowsPerPage;

    const { startDate, endDate } = req.query;
    let filter = {};
    if (startDate || endDate) {
      filter.order_date = {};
      if (startDate) {
        filter.order_date.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.order_date.$lte = new Date(endDate);
      }
    }

    const orders = await Order.find(filter)
      .skip(skip)
      .limit(rowsPerPage)
      .sort({ createdAt: -1 });

    const totalOrders = await Order.countDocuments(filter);
    res.json({ message: orders, totalOrders });
  } catch (error) {
    res.status(500).json({ message: "Error fetching orders", error: error.message });
  }
});

app.post('/api/shipway/neworder', async (req, res) => {
  try {
    const { order_id, shipment_status, order_date } = req.body;
    if (!order_id || !shipment_status) {
      return res.status(400).json({ message: "Missing order_id or shipment_status" });
    }
    const status = statusMapping[shipment_status] || shipment_status;
    const date = order_date ? new Date(order_date) : null;
    // Normalize order_id before updating
    const normalizedOrderId = order_id.replace(/^#/, '');
    await Order.updateOne(
      { order_id: normalizedOrderId },
      { order_id: normalizedOrderId, shipment_status: status, order_date: date },
      { upsert: true }
    );
    res.json({ message: "Order saved/updated" });
  } catch (error) {
    res.status(500).json({ message: "Error saving new order", error: error.message });
  }
});


app.get('/api/orders/by-shipment-status', async (req, res) => {
  try {
    const { shipment_status } = req.query;

    if (!shipment_status) {
      return res.status(400).json({ message: 'shipment_status is required' });
    }

    const pipeline = [
      { $sort: { order_date: -1 } }, // newest first
      {
        $group: {
          _id: "$contact_number",
          mostRecentOrder: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$mostRecentOrder" } },
      { $match: { shipment_status } } // exact match for the provided status
    ];

    const recentOrders = await Order.aggregate(pipeline);

    res.json(recentOrders);
  } catch (error) {
    console.error("Error fetching orders by shipment status:", error);
    res.status(500).json({ message: 'Failed to fetch orders', error: error.message });
  }
});


// Cron job to update shipment status every hour
cron.schedule('0 8 * * *', async () => {
  try {
    const orders = await Order.find({});
    for (const order of orders) {
      try {
        if (!order.order_date) continue;

        // Skip update if status is final
        if (order.shipment_status === "Delivered" || order.shipment_status === "RTO Delivered") {
          console.log(`Skipping cron update for order ${order.order_id} with final status: ${order.shipment_status}`);
          continue;
        }
        const page = 1;
        const dateStr = order.order_date.toISOString().split("T")[0];
        const ordersFromShipway = await fetchOrdersFromShipway(page, dateStr, dateStr);
        // Find matching order using normalized order_id
        const updatedOrder = ordersFromShipway.find(o => o.order_id.replace(/^#/, '') === order.order_id);
        if (updatedOrder) {
          const shipmentStatus = statusMapping[updatedOrder.shipment_status] || updatedOrder.shipment_status;
          await Order.updateOne({ order_id: order.order_id }, { shipment_status: shipmentStatus });
        }
      } catch (err) {
        console.error(`Error updating order ${order.order_id}:`, err);
      }
    }
  } catch (error) {
    console.error("Cron job error:", error);
  }
});

// Utility: Normalize phone (strip +91, spaces etc)
function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, '').replace(/^91/, '');
  return cleaned.length === 10 ? cleaned : "";
}


// Function: fetch Shopify customers by phone (phone numbers normalized for matching)
async function fetchShopifyFirstOrderDateByPhone(phone) {
  if (!phone) return null;

  const shopifyBase = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04`;

  try {
    console.log(`Fetching Shopify customer for phone: ${phone}`);

    // Fetch customers by phone
    const customerRes = await axios.get(`${shopifyBase}/customers.json`, {
      params: { phone },
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const customers = customerRes.data.customers;

    if (!customers || customers.length === 0) {
      console.log(`No Shopify customers found for phone: ${phone}`);
      return null;
    }

    const customer = customers[0];

    if (!customer.orders_count || customer.orders_count === 0) {
      console.log(`Customer ${customer.id} has no orders`);
      return null;
    }

    console.log(`Fetching orders for customer ID: ${customer.id}`);

    // Fetch orders for this customer sorted by created_at ascending
    const ordersRes = await axios.get(`${shopifyBase}/orders.json`, {
      params: {
        customer_id: customer.id,
        status: 'any',
        limit: 250,
        order: 'created_at asc',
      },
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    });

    const orders = ordersRes.data.orders;

    if (!orders || orders.length === 0) {
      console.log(`No orders found for customer ID: ${customer.id}`);
      return null;
    }

    const firstOrderDate = orders[0].created_at.split('T')[0];
    console.log(`First order date for customer ID ${customer.id} is ${firstOrderDate}`);
    return firstOrderDate;
  } catch (error) {
    console.error("Error fetching Shopify first order date:", error.message);
    return null;
  }
}

app.post('/api/leads/update-lastOrderDate-from-shopify', async (req, res) => {
  try {
    console.log("Starting update of lastOrderDate from Shopify...");

    // Step 1: Get leads with missing lastOrderDate and salesStatus = "Sales Done"
    const leadsToUpdate = await Lead.find({
      $and: [
        {
          $or: [
            { lastOrderDate: { $exists: false } },
            { lastOrderDate: null },
            { lastOrderDate: "" }
          ]
        },
        { salesStatus: "Sales Done" }
      ]
    }, "contactNumber lastOrderDate");

    console.log(`Found ${leadsToUpdate.length} Sales Done leads needing lastOrderDate update`);

    if (!leadsToUpdate.length) {
      return res.json({ message: "No leads require lastOrderDate update" });
    }

    // Step 2: Normalize phone numbers and map to lead IDs
    const phoneToLeadsMap = {};

    leadsToUpdate.forEach((lead) => {
      const phone = normalizePhone(lead.contactNumber);
      if (!phone) return;
      if (!phoneToLeadsMap[phone]) phoneToLeadsMap[phone] = [];
      phoneToLeadsMap[phone].push(lead._id);
    });

    // Step 3: Process each unique phone only once
    let updatedCount = 0;

    for (const phone of Object.keys(phoneToLeadsMap)) {
      console.log(`Fetching Shopify data for phone: ${phone}`);
      const firstOrderDate = await fetchShopifyFirstOrderDateByPhone(phone);

      if (firstOrderDate) {
        // Update all leads with this phone
        await Lead.updateMany(
          { _id: { $in: phoneToLeadsMap[phone] } },
          { lastOrderDate: firstOrderDate }
        );
        console.log(`Updated ${phoneToLeadsMap[phone].length} leads for phone ${phone}`);
        updatedCount += phoneToLeadsMap[phone].length;
      } else {
        console.log(`No order date found for phone: ${phone}`);
      }
    }

    console.log(`Update completed. Total leads updated: ${updatedCount}`);
    res.json({ message: `Updated lastOrderDate for ${updatedCount} leads from Shopify` });
  } catch (error) {
    console.error("Error updating lastOrderDate from Shopify:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

const upload = multer({
  dest: "uploads/",
  fileFilter: (req, file, cb) => {
    const filetypes = /csv|xlsx/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (extname) return cb(null, true);
    cb("Error: File type not supported!");
  },
});

app.post("/api/bulk-upload", upload.single("file"), async (req, res) => {
  const filePath = req.file.path;

  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const requiredFields = ["Date", "Name", "Contact No"];
    const errors = [];

    const leads = rows.map((row, index) => {
      const missingFields = requiredFields.filter((field) => !row[field]);
      if (missingFields.length > 0) {
        errors.push(`Row ${index + 2} is missing mandatory fields: ${missingFields.join(", ")}`);
        return null;
      }
      return {
        date: new Date().toISOString().split("T")[0],
        time: row.Time || "",
        name: row.Name,
        contactNumber: row["Contact No"],
        leadSource: row["Lead Source"] || "",
        enquiryFor: row["Enquiry For"] || "",
        customerType: row["Customer Type"] || "",
        agentAssigned: row["Agent Assigned"] || "",
        productPitched: row["Product Pitched"] ? row["Product Pitched"].split(",") : [],
        leadStatus: row["Lead Status"] || "",
        salesStatus: row["Sales Status"] || "",
        nextFollowup: row["Next Followup"] || "",
        calculateReminder: row.Reminder || "",
        agentsRemarks: row["Agent's Remarks"] || "",
        productsOrdered: row["Products Ordered"] ? row["Products Ordered"].split(",") : [],
        dosageOrdered: row["Dosage Ordered"] || "",
        amountPaid: row["Amount Paid"] || 0,
        modeOfPayment: row["Mode of Payment"] || "",
        deliveryStatus: row["Delivery Status"] || "",
        healthExpertAssigned: row["Health Expert Assigned"] || "",
        orderId: row["Order ID"] || "",
        dosageExpiring: row["Dosage Expiring"] || "",
        rtNextFollowupDate: row["RT Next Followup Date"] || "",
        rtFollowupReminder: row["RT-Followup Reminder"] || "",
        rtFollowupStatus: row["RT-Followup Status"] || "",
        repeatDosageOrdered: row["Repeat Dosage Ordered"] || "",
        retentionStatus: row["Retention Status"] || "",
        rtRemark: row["RT-Remark"] || "",
      };
    });

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join(". ") });
    }

    await Lead.insertMany(leads.filter(Boolean));
    res.json({ success: true });
  } catch (err) {
    console.error("Error processing file:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


app.get('/api/leads/check-duplicate', async (req, res) => {
  const { contactNumber } = req.query;

  try {
    const lead = await Lead.findOne({ contactNumber });
    if (lead) {
      return res.status(200).json({ exists: true });
    }
    return res.status(200).json({ exists: false });
  } catch (error) {
    console.error("Error checking duplicate:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


app.get('/api/leads', async (req, res) => {
  const { page = 1, limit = 30, filters = '{}', agentAssignedName, salesStatus, sortBy = '_id', sortOrder = 'desc' } = req.query;
  const filterCriteria = JSON.parse(filters);

  const parseDate = (dateString) => {
    if (!dateString) return null;
    const parsedDate = new Date(dateString);
    return isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString().split("T")[0];
  };

  try {
    const query = {};

    if (filterCriteria.name) query.name = { $regex: filterCriteria.name, $options: 'i' };
    if (filterCriteria.contactNumber) query.contactNumber = filterCriteria.contactNumber;
    if (filterCriteria.leadSource?.length) query.leadSource = { $in: filterCriteria.leadSource }; 

    if (filterCriteria.startDate || filterCriteria.endDate) {
      query.date = {};
      if (filterCriteria.startDate) {
        const parsedStartDate = parseDate(filterCriteria.startDate);
        if (parsedStartDate) query.date.$gte = parsedStartDate;
      }
      if (filterCriteria.endDate) {
        const parsedEndDate = parseDate(filterCriteria.endDate);
        if (parsedEndDate) query.date.$lte = parsedEndDate;
      }
      if (Object.keys(query.date).length === 0) delete query.date;
    }
 
    if (filterCriteria.lastOrderDate) {
      const parsedlastOrderDate = parseDate(filterCriteria.lastOrderDate);
      if (parsedlastOrderDate) {
        query.lastOrderDate = parsedlastOrderDate;
      }
    }

    if (filterCriteria.agentAssigned?.length) query.agentAssigned = { $in: filterCriteria.agentAssigned };
    if (filterCriteria.leadStatus?.length) query.leadStatus = { $in: filterCriteria.leadStatus };
    if (filterCriteria.salesStatus?.length) query.salesStatus = { $in: filterCriteria.salesStatus };
    if (filterCriteria.deliveryStatus) query.deliveryStatus = filterCriteria.deliveryStatus;
    if (filterCriteria.customerType) query.customerType = filterCriteria.customerType;
    if (filterCriteria.healthExpertAssigned) query.healthExpertAssigned = filterCriteria.healthExpertAssigned;
    if (filterCriteria.rtFollowupStatus?.length) query.rtFollowupStatus = { $in: filterCriteria.rtFollowupStatus };
    if (filterCriteria.retentionStatus) query.retentionStatus = filterCriteria.retentionStatus;
    if (filterCriteria.enquiryFor?.length) query.enquiryFor = { $in: filterCriteria.enquiryFor };

    if (filterCriteria.reminder) {
      const today = new Date();
      if (filterCriteria.reminder === "Today") {
        query.nextFollowup = { $eq: today.toISOString().split("T")[0] };
      } else if (filterCriteria.reminder === "Tomorrow") {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        query.nextFollowup = { $eq: tomorrow.toISOString().split("T")[0] };
      } else if (filterCriteria.reminder === "Follow-up Missed") {
        query.nextFollowup = { $lt: today.toISOString().split("T")[0] };
      } else if (filterCriteria.reminder === "Later") {
        query.nextFollowup = { $gt: today.toISOString().split("T")[0] };
      }
    }

    if (filterCriteria.rtFollowupReminder) {
      const today = new Date();
      if (filterCriteria.rtFollowupReminder === "Today") {
        query.rtNextFollowupDate = { $eq: today.toISOString().split("T")[0] };
      } else if (filterCriteria.rtFollowupReminder === "Tomorrow") {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        query.rtNextFollowupDate = { $eq: tomorrow.toISOString().split("T")[0] };
      } else if (filterCriteria.rtFollowupReminder === "Follow-up Missed") {
        query.rtNextFollowupDate = { $lt: today.toISOString().split("T")[0] };
      } else if (filterCriteria.rtFollowupReminder === "Later") {
        query.rtNextFollowupDate = { $gt: today.toISOString().split("T")[0] };
      }
    }

    if (agentAssignedName) query.agentAssigned = agentAssignedName;
    if (salesStatus) query.salesStatus = salesStatus;

    const totalLeads = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .sort({ _id: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.status(200).json({
      leads,
      totalLeads,
      totalPages: Math.ceil(totalLeads / limit),
      currentPage: Number(page),
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ message: 'Error fetching leads', error });
  }
});


app.post('/api/leads', async (req, res) => {
  try {
    const newLead = new Lead(req.body);
    await newLead.save();
    res.status(201).json({ message: 'Lead added successfully', lead: newLead });
  } catch (error) {
    console.error('Error adding lead:', error);
    res.status(500).json({ message: 'Error adding lead', error });
  }
});


app.put('/api/leads/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const updatedLead = await Lead.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updatedLead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.status(200).json({ message: 'Lead updated successfully', lead: updatedLead });
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ message: 'Error updating lead', error: error.message });
  }
});


app.delete('/api/leads/:id', async (req, res) => {
  try {
    // Delete the lead document by ID
    const deletedLead = await Lead.findByIdAndDelete(req.params.id);
    if (!deletedLead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Also delete the corresponding MyOrder document based on the contact number
    await MyOrder.deleteOne({ phone: deletedLead.contactNumber });

    res.status(200).json({ message: 'Lead and corresponding MyOrder deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting lead', error });
  }
});

function getReminderType(nextFollowupDate) {
  if (!nextFollowupDate) return "NotSet";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const followupDate = new Date(nextFollowupDate);
  followupDate.setHours(0, 0, 0, 0);
  const diffInDays = Math.ceil((followupDate - today) / (1000 * 60 * 60 * 24)); 
  if (isNaN(diffInDays)) return "NotSet";
  if (diffInDays < 0) return "Missed";
  if (diffInDays === 0) return "Today";
  if (diffInDays === 1) return "Tomorrow";
  return "Later";
}

app.get("/api/leads/retention", async (req, res) => {
  try {
    let {
      page = 1,
      limit = 20,
      search = "",
      retentionStatus = "All",
      followup,
      agentAssigned,
      healthExpertAssigned,
    } = req.query;

    page = parseInt(page);
    limit = parseInt(limit);

    // Build MongoDB match object
    let match = { salesStatus: "Sales Done" };

    // Top filter: Active/Lost
    if (retentionStatus && retentionStatus !== "All") {
      match.retentionStatus = retentionStatus;
    }

    // Search filter: Name, Contact, Order ID (case-insensitive)
    if (search && search.trim() !== "") {
      const s = search.trim();
      match.$or = [
        { name: { $regex: s, $options: "i" } },
        { contactNumber: { $regex: s, $options: "i" } },
        { orderId: { $regex: s, $options: "i" } },
      ];
    }

    // Filter by agentAssigned (multi)
    if (agentAssigned) {
      let arr = Array.isArray(agentAssigned)
        ? agentAssigned
        : agentAssigned.split(",");
      match.agentAssigned = { $in: arr };
    }

    // Filter by healthExpertAssigned (multi)
    if (healthExpertAssigned) {
      let arr = Array.isArray(healthExpertAssigned)
        ? healthExpertAssigned
        : healthExpertAssigned.split(",");
      match.healthExpertAssigned = { $in: arr };
    }

    // Add calculated reminder with MongoDB $addFields
    const addFieldsStage = {
      $addFields: {
        calculatedReminder: {
          $switch: {
            branches: [
              {
                case: {
                  $or: [
                    { $eq: ["$rtNextFollowupDate", null] },
                    { $eq: ["$rtNextFollowupDate", ""] },
                    { $eq: ["$rtNextFollowupDate", undefined] },
                  ]
                },
                then: "NotSet"
              },
            ],
            default: {
              $let: {
                vars: {
                  followup: {
                    $dateFromString: {
                      dateString: "$rtNextFollowupDate",
                    }
                  },
                  today: {
                    $dateFromParts: {
                      year: { $year: { $toDate: "$$NOW" } },
                      month: { $month: { $toDate: "$$NOW" } },
                      day: { $dayOfMonth: { $toDate: "$$NOW" } }
                    }
                  }
                },
                in: {
                  $switch: {
                    branches: [
                      // Missed: Date is before today
                      {
                        case: {
                          $lt: [
                            { $subtract: ["$$followup", "$$today"] }, 0
                          ]
                        },
                        then: "Missed"
                      },
                      // Today: Date is today
                      {
                        case: {
                          $eq: [
                            { $trunc: { $divide: [{ $subtract: ["$$followup", "$$today"] }, 1000 * 60 * 60 * 24] } }, 0
                          ]
                        },
                        then: "Today"
                      },
                      // Tomorrow: Date is tomorrow
                      {
                        case: {
                          $eq: [
                            { $trunc: { $divide: [{ $subtract: ["$$followup", "$$today"] }, 1000 * 60 * 60 * 24] } }, 1
                          ]
                        },
                        then: "Tomorrow"
                      },
                    ],
                    // Later: Any other future date
                    default: "Later"
                  }
                }
              }
            }
          }
        }
      }
    };

    // 1. For pill counts (all, not just current page)
    const countPipeline = [
      { $match: match },
      addFieldsStage,
      {
        $group: {
          _id: "$calculatedReminder",
          count: { $sum: 1 }
        }
      }
    ];

    // 2. For top filter counts (All/Active/Lost)
    const statusCountsPromise = Lead.aggregate([
      { $match: { salesStatus: "Sales Done" } },
      {
        $group: {
          _id: { $ifNull: ["$retentionStatus", "Active"] },
          count: { $sum: 1 },
        }
      }
    ]);

    // 3. Main data query
    let mainPipeline = [
      { $match: match },
      addFieldsStage
    ];

    // Filter on selected followup (if set)
    if (followup) {
      mainPipeline.push({ $match: { calculatedReminder: followup } });
    }

    mainPipeline.push(
      { $sort: { lastOrderDate: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    );

    // Run all queries in parallel
    let [leads, followupCountsArr, statusCountsArr] = await Promise.all([
      Lead.aggregate(mainPipeline),
      Lead.aggregate(countPipeline),
      statusCountsPromise,
    ]);

    // Calculate profile completion % for each lead
    const profileFields = [
      "name", "contactNumber", "agentAssigned", "leadSource", "enquiryFor",
      "orderId", "productsOrdered", "amountPaid", "modeOfPayment", "deliveryStatus",
      "dosageOrdered", "rtNextFollowupDate", "customerType", "retentionStatus",
      "healthExpertAssigned", "agentsRemarks", "dosageExpiring", "repeatDosageOrdered", "rtRemark"
    ];

    for (let lead of leads) {
      let filled = 0;
      for (let field of profileFields) {
        let value = lead[field];
        if (Array.isArray(value)) {
          if (value.length > 0) filled++;
        } else if (value !== null && value !== undefined && value !== "") {
          filled++;
        }
      }
      lead.profilePercent = Math.round((filled / profileFields.length) * 100);
    }

    // Format pill counts
    const counts = { Today: 0, Tomorrow: 0, Missed: 0, Later: 0, NotSet: 0 };
    for (const f of followupCountsArr) {
      counts[f._id] = f.count;
    }

    // Format top status counts
    let topCounts = { All: 0, Active: 0, Lost: 0 };
    let total = 0;
    for (const s of statusCountsArr) {
      let key = s._id === "Lost" ? "Lost" : "Active";
      if (s._id === "Lost") topCounts.Lost = s.count;
      else topCounts.Active += s.count;
      total += s.count;
    }
    topCounts.All = total;

    // Response
    res.json({
      leads,
      counts,
      topCounts,
      page,
      limit,
    });

  } catch (err) {
    console.error("Retention API error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/leads/retentions', async (req, res) => {
  const { fullName, email } = req.query;

  if (!fullName || !email) {
    return res.status(400).json({ message: 'Full name and email are required' }); 
  }

  try { 
    const leads = await Lead.find({
      healthExpertAssigned: { $in: [fullName, `${fullName} (${email})`] },
      salesStatus: "Sales Done",
    });
    res.status(200).json(leads);
  } catch (error) {
    console.error('Error fetching retention leads:', error);
    res.status(500).json({ message: 'Error fetching retention leads', error }); 
  }
});
  

app.patch('/api/leads/:id/images', async (req, res) => {
  const leadId = req.params.id;
  const { images } = req.body;  

  try {
    const lead = await Lead.findById(leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' }); 

    lead.images = images; // replace images array
    await lead.save();

    res.json({ message: 'Images updated', lead });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});
 
app.post('/api/leads/:id/reachout-log', async (req, res) => {
  try {
    const { id } = req.params;
    const { timestamp, method, status } = req.body;

    if (!timestamp) return res.status(400).json({ message: "Missing timestamp" });

    const lead = await Lead.findById(id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    lead.reachoutLogs = lead.reachoutLogs || [];

    // Update if existing timestamp match
    const existing = lead.reachoutLogs.find(log => log.timestamp?.toISOString() === new Date(timestamp).toISOString());
    if (existing) {
      if (method) existing.method = method;
      if (status) existing.status = status;
    } else {
      lead.reachoutLogs.push({ timestamp, method, status });
    }

    await lead.save();
    res.status(200).json({ message: "Reachout log updated" });
  } catch (err) {
    console.error("Reachout Log Save Error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

app.get("/api/leads/:id/reachout-logs", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id, "reachoutLogs");
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    res.status(200).json(lead.reachoutLogs);
  } catch (error) {
    res.status(500).json({ message: "Error fetching logs", error: error.message });
  }
});

app.get('/api/leads/new-orders', async (req, res) => {
  try {
    // Extract page, limit, and other filter parameters from query
    const { page = 1, limit = 30, ...filters } = req.query;
  
    const query = {
      salesStatus: "Sales Done",
      agentAssigned: { $nin: ['Admin', 'Online Order'] }
    };

    if (filters.name) {
      query.name = { $regex: filters.name, $options: "i" };
    }
    if (filters.contactNumber) {
      query.contactNumber = { $regex: filters.contactNumber };
    }
    if (filters.agentName) {
      let agentArr = filters.agentName;
      if (!Array.isArray(agentArr)) {
        agentArr = [agentArr];
      }
      query.agentAssigned = { $in: agentArr };
    }
    if (filters.healthExpertAssigned) {
      if (filters.healthExpertAssigned === "blank") {
        query.$or = [
          { healthExpertAssigned: { $exists: false } },
          { healthExpertAssigned: "" },
          { healthExpertAssigned: { $regex: /^\s*$/ } }
        ];
      } else {
        query.healthExpertAssigned = { $regex: filters.healthExpertAssigned, $options: "i" };
      }
    }
    if (filters.modeOfPayment) {
      let paymentArr = filters.modeOfPayment;
      if (!Array.isArray(paymentArr)) {
        paymentArr = [paymentArr];
      }
      query.modeOfPayment = { $in: paymentArr };
    }
    if (filters.deliveryStatus) {
      let deliveryArr = filters.deliveryStatus;
      if (!Array.isArray(deliveryArr)) {
        deliveryArr = [deliveryArr];
      }
      query.deliveryStatus = { $in: deliveryArr };
    }
    if (filters.productsOrdered) {
      let productsArr = filters.productsOrdered;
      if (!Array.isArray(productsArr)) {
        productsArr = [productsArr];
      }
      query.productsOrdered = { $in: productsArr };
    }

    // Date filtering on lastOrderDate
    if (filters.startDate) {
      query.lastOrderDate = query.lastOrderDate || {};
      query.lastOrderDate.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      query.lastOrderDate = query.lastOrderDate || {};
      query.lastOrderDate.$lte = new Date(filters.endDate);
    }
    if (filters.orderDate) {
      const orderDateStart = new Date(filters.orderDate);
      const orderDateEnd = new Date(filters.orderDate);
      orderDateEnd.setDate(orderDateEnd.getDate() + 1);
      query.lastOrderDate = { $gte: orderDateStart, $lt: orderDateEnd };
    }

    // Convert page and limit to numbers and calculate skip
    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const skip = (pageNumber - 1) * limitNumber;

    // Get total count for pagination (with filters applied)
    const total = await Lead.countDocuments(query);

    // Find leads using the query, applying sorting, skip, and limit
    const leads = await Lead.find(query, {
      lastOrderDate: 1,
      name: 1,
      contactNumber: 1,
      agentAssigned: 1,
      productsOrdered: 1,
      dosageOrdered: 1,
      healthExpertAssigned: 1,
      agentsRemarks: 1,
      amountPaid: 1,
      modeOfPayment: 1,
      deliveryStatus: 1,
    })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limitNumber);

    res.status(200).json({
      leads,
      total,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(total / limitNumber),
    });
  } catch (error) {
    res.status(500).json({
      message: 'Error fetching new orders',
      error: error.message,
    });
  }
});

app.get('/api/leads/assigned', async (req, res) => {
  const { agentAssigned } = req.query;
  if (!agentAssigned) {
    return res.status(400).json({ message: 'Agent email is required.' });
  }

  try {
    const leads = await Lead.find({ agentAssigned });
    res.status(200).json(leads);
  } catch (error) {
    console.error('Error fetching assigned leads:', error);
    res.status(500).json({ message: 'Error fetching assigned leads', error });
  }
});

app.get('/api/retention-orders', async (req, res) => {
  try {
    const orders = await RetentionSales.find({});
    res.json(orders);
  } catch (error) {
    console.error('Error fetching retention orders:', error);
    res.status(500).json({ message: 'Failed to fetch retention orders', error: error });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.status(200).json(lead);
  } catch (error) {
    console.error("Error fetching lead:", error);
    res.status(500).json({ message: "Error fetching lead", error: error.message }); 
  }
});

app.get('/api/consultation-history', async (req, res) => {
  try {
    const { contactNumber } = req.query;
    if (!contactNumber) return res.status(400).json({ error: "Missing contactNumber" });

    // 1. Find customer by phone 
    const customer = await Customer.findOne({ phone: contactNumber });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // 2. Find consultation details by customerId
    const consultations = await ConsultationDetails.find({ customerId: customer._id }).sort({ createdAt: -1 });

    res.json({ consultations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } 
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
