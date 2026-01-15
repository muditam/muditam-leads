require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const dns = require('dns');
const cors = require('cors');
const multer = require("multer");
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const Lead = require('./models/Lead');
const Customer = require('./models/Customer');
const ConsultationDetails = require('./models/ConsultationDetails');
const XLSX = require("xlsx");
const axios = require('axios');
const http = require("http");
const { Server } = require("socket.io");
const https = require('https');
const cron = require('node-cron');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const compression = require('compression');
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
const dietPlanProxy = require("./routes/dietPlanProxy");
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

const financeDashboard = require("./routes/financeDashboard");
const UndeliveredordersRoute = require('./operations/undelivered-orders');

const zohoMailRoutes = require("./routes/zohoMail");

const smartfloRoutes = require("./routes/smartflo");

const ReturnDeliveredRoutes = require("./routes/ReturnDelivered");

const dietTemplatesRouter = require("./routes/dietTemplatesadmin");

const dietPlansRouter = require("./routes/dietPlans");

const ordersRouter = require("./routes/ShopifyOrderDB");

const cohartDataApiRouter = require("./routes/cohart-dataApi");

const allProductsFromOrdersRoute = require("./routes/allProductsFromOrders");

const shopifyOrdersTable = require("./routes/shopifyOrdersTable");

const leadsMigration = require('./routes/leadMigration');
const orderConfirmationsRouter = require("./routes/orderConfirmations");
const scheduleCallsRouter = require("./routes/scheduleCalls");
const opsDashboardRoutes = require("./routes/opsDashboard");
const orderConfirmAnalytics = require("./routes/orderConfirmAnalytics");
const assetsRoutes = require("./routes/add-assets");
const assetAllotmentsRoutes = require("./routes/assetAllotments");
const assetJourneyRouter = require("./routes/assetJourney");
const UnAssignedDelivered = require("./routes/UnAssignedDelivered");

const bobotSyncRoutes = require('./routes/bobotSync');

const shipmentSyncRouter = require("./routes/shipmentSync");

const bankTxnRouter = require("./PaymentGateway/bankEntries");
const bankCapital6389Routes = require("./PaymentGateway/bankCapital6389");
const bankAxis3361Routes = require("./PaymentGateway/bankAxis3361");
const bankCc1101Routes = require("./PaymentGateway/bankCc1101");
const bankYesCcTejasvRoutes = require("./PaymentGateway/bankYesCcTejasv");
const bankYesCcAbhayRoutes = require("./PaymentGateway/bankYesCcAbhay");
const taskBoardRoutes = require("./routes/taskBoardRoutes");
const taskReportingRoutes = require("./routes/taskReportingRoutes");
const SwitchEmployee = require("./routes/SwitchEmployee");
const ConfirmedOrders = require("./routes/confirmedOrders");
const invoiceRoutes = require('./routes/invoiceRoutes');

const globalShopifyOrders = require("./International/globalShopifyOrders");
const globalAbandonedCarts = require("./International/globalAbandonedCarts");
const globalRetentionLeads = require("./International/InternationalRoutes/globalRetentionLeads");
const globalRetentionDetails = require("./International/InternationalRoutes/globalRetentionDetails");
const globalRetentionSalesRoutes = require("./International/InternationalRoutes/globalRetentionSales");

const accessManagementRoutes = require("./routes/accessManagementRoutes");
const superAdminAnalytics = require("./routes/superAdminAnalytics");
// const retentionAuto = require("./routes/retentionAutoReactivate");

const vendorsRoute = require("./routes/vendorsname");
const purchaseRoute = require("./routes/PurchaseRcrds");
const paymentRoute = require("./routes/paymentRcrds");
const shopifyExport = require("./routes/shopifyExport");
const utmShopifyRoutes = require("./routes/utmShopifyRoutes");
const notificationsRoutes = require("./routes/notifications");

const WhatsAppRoutes = require("./whatsapp/whatsapp.routes");
const whatsappTemplatesRoutes = require("./whatsapp/whatsappTemplatesroutes");
const whatsappMediaRoutes = require("./whatsapp/whatsappMedia.routes");
const whatsappAiRoutes = require("./whatsapp/whatsapp.ai.routes");

const app = express();
const PORT = process.env.PORT || 5001;



app.use(
  compression({
    filter: (req, res) => {
      if (req.path === '/api/sse') return false;

      const type = String(res.getHeader('Content-Type') || '');
      if (type.includes('text/event-stream')) return false;

      return compression.filter(req, res);
    },
  })
);


const allowedOrigins = ['https://www.60brands.com', 'https://60brands.com', 'http://localhost:3000'];

dns.setServers(['8.8.8.8', '1.1.1.1']);

const rawSaver = (req, res, buf) => { req.rawBody = buf; };

// Start Server
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => {
      // allow non-browser clients (no origin)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Socket.IO CORS blocked origin: ${origin}`), false);
    },
    credentials: true,
    methods: ["GET", "POST"],
  },

  transports: ["polling", "websocket"],  
  allowUpgrades: true,
  pingTimeout: 20000,
  pingInterval: 25000,
});

io.engine.on("connection_error", (err) => {
  console.log("[socket.io] connection_error", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

app.set("io", io);
 
const digitsOnly = (v = "") => String(v || "").replace(/\D/g, "");
const last10 = (v = "") => digitsOnly(v).slice(-10);

io.on("connection", (socket) => {
  socket.on("wa:join", ({ phone10, phone } = {}) => {
    const p10 = last10(phone10 || phone || "");
    if (!p10) return;
    socket.join(`wa:${p10}`);
  });

  socket.on("wa:leave", ({ phone10, phone } = {}) => {
    const p10 = last10(phone10 || phone || "");
    if (!p10) return;
    socket.leave(`wa:${p10}`);
  });
});

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-agent-name', 'x-user-json'],
  })
);

app.options("*", cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "x-agent-name",
    "x-user-json",
  ],
}));

app.set("trust proxy", 1);
 
const isProd = process.env.NODE_ENV === "production";

app.use(session({
  name: "sid",
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd, // true only on https
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

function toNumberLoose(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.\-]/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isNaN(n) ? undefined : n;
  }
  if (typeof v === "object") {
    return toNumberLoose(v.amount ?? v.value ?? v.price ?? v.total ?? v.gross ?? v.net);
  }
  return undefined;
}
const pickFirst = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");

function majorToMinor(v) {
  const n = toNumberLoose(v);
  if (n === undefined) return undefined;
  return Math.round(n * 100);
}

function isAbandoned(root, mergedTypeText = "") {
  if (root?.is_abandoned === true) return true;
  const txt = String(mergedTypeText || "").toLowerCase();
  if (/abandon/.test(txt)) return true;
  if (root?.status === "abandoned" || root?.checkout_status === "abandoned" || root?.cart_status === "abandoned") return true;
  return false;
}

function hashId(buf) {
  try { return crypto.createHash("sha256").update(buf).digest("hex"); }
  catch { return undefined; }
}

app.post(
  "/api/webhook",
  bodyParser.json({ verify: rawSaver, limit: "2mb", type: ["application/json", "application/cloudevents+json", "text/json"] }),
  bodyParser.urlencoded({ verify: rawSaver, extended: false, limit: "2mb", type: ["application/x-www-form-urlencoded"] }),
  bodyParser.text({ verify: rawSaver, type: ["text/plain"], limit: "2mb" }),
  async (req, res) => {
    try {
      const ctype = (req.headers["content-type"] || "").split(";")[0];
      const raw = req.rawBody || Buffer.from("");

      const sharedSecret = process.env.GOKWIK_WEBHOOK_SECRET;
      const sig = req.get("X-GK-Signature") || req.get("x-gk-signature");
      if (sharedSecret && sig) {
        const digest = crypto.createHmac("sha256", sharedSecret).update(raw).digest("hex");
        const ok = sig.replace(/^sha256=/, "") === digest;
        if (!ok) return res.status(401).send("Invalid signature");
      }

      let event;
      if (ctype === "application/json" || ctype === "application/cloudevents+json" || ctype === "text/json") {
        event = req.body;
      } else if (ctype === "application/x-www-form-urlencoded") {
        const params = req.body;
        if (typeof params.payload === "string") {
          try { event = JSON.parse(params.payload); } catch { event = params; }
        } else event = params;
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

      const root = event?.data || event?.payload || event;

      const typeText = [
        event?.type, event?.event, event?.topic, event?.event_type,
        root?.event, root?.event_type, root?.event_name, root?.name
      ].filter(Boolean).join("|");

      const rawForHash = raw?.length ? raw : Buffer.from(JSON.stringify(event || {}));

      const eventId = pickFirst(root.request_id, event.id, event.event_id) || hashId(rawForHash);
      const checkoutId = pickFirst(root.token, root.checkout_id, root.cart_id, root.checkout_token);
      const orderId = pickFirst(root.order_id, root.orderId);

      const cust = root.customer || root.customer_details || {};
      const addr = root.address || {};
      const shipping = root.shipping_address || root.shipping || {};
      const billing = root.billing_address || root.billing || {};

      const stateName = pickFirst(
        cust.state, cust.province, cust.region,
        addr.state, addr.province, addr.region,
        shipping.state, shipping.province, shipping.region,
        billing.state, billing.province, billing.region,
        root.state, root.province, root.region
      );

      const email = pickFirst(
        cust.email, addr.email, shipping.email, billing.email,
        root.email, root.customer_email, root.contact_email, root.user_email
      );

      const phone = pickFirst(
        cust.phone, addr.phone, shipping.phone, billing.phone,
        root.phone, root.mobile, root.mobile_number, root.contact, root.contact_number,
        root.whatsapp, root.whatsapp_number, root.customer_phone, root.user_phone
      );

      const customer = {
        name:
          pickFirst(
            [cust.firstname, cust.lastname].filter(Boolean).join(" ").trim(),
            (addr.firstname || addr.lastname)
              ? [addr.firstname, addr.lastname].filter(Boolean).join(" ").trim()
              : undefined,
            cust.name, addr.name, shipping.name, billing.name, root.name
          ) || undefined,
        email: email || undefined,
        phone: phone || undefined,
        state: stateName ? String(stateName) : undefined,
      };

      const addressParts = {
        name: pickFirst(shipping.name, billing.name, addr.name, customer.name, root.name),
        line1: pickFirst(shipping.address1, billing.address1, addr.address1, root.address1, root.addr1),
        line2: pickFirst(shipping.address2, billing.address2, addr.address2, root.address2, root.addr2),
        city: pickFirst(shipping.city, billing.city, addr.city, root.city),
        state: customer.state,
        postalCode: pickFirst(
          shipping.zip, billing.zip, addr.zip,
          shipping.postal_code, billing.postal_code, addr.postal_code,
          root.zip, root.postal_code, root.pincode, root.pin_code
        ),
        country: pickFirst(shipping.country, billing.country, addr.country, root.country),
      };

      function compactAddressStr(p) {
        return [p.name, p.line1, p.line2, p.city, p.state, p.postalCode, p.country]
          .map(x => (x || "").toString().trim())
          .filter(Boolean)
          .join(", ");
      }
      const customerAddressText = compactAddressStr(addressParts);

      const itemsSrc = Array.isArray(root.items)
        ? root.items
        : (Array.isArray(root.line_items) ? root.line_items : []);
      const items = itemsSrc.map((it) => {
        const qty = Number(pickFirst(it.quantity, it.qty, 1)) || 1;
        const unitMinor = toNumberLoose(pickFirst(it.final_price, it.price, it.original_price)) ?? 0;
        const lineMinor = toNumberLoose(pickFirst(it.final_line_price, it.line_price)) ?? unitMinor * qty;
        const variantTitle =
          it.variant_title ||
          [it.option1, it.option2, it.option3].filter(Boolean).join(" / ") ||
          "";

        return {
          sku: it.sku || String(it.variant_id || it.id || ""),
          title: it.title || it.product_title || it.name || "",
          variantTitle,
          quantity: qty,
          unitPrice: unitMinor,
          finalLinePrice: lineMinor,
        };
      });

      const currency = pickFirst(root.currency, "INR");
      const totalMinor =
        toNumberLoose(root.total_price) !== undefined
          ? majorToMinor(root.total_price)
          : (
            items.reduce((s, it) => s + (it.finalLinePrice || 0), 0) ||
            majorToMinor(root.items_subtotal_price) ||
            majorToMinor(root.original_total_price) ||
            0
          );

      const eventAt =
        (root.created_at && new Date(root.created_at)) ||
        (root.updated_at && new Date(root.updated_at)) ||
        (event.timestamp && new Date(event.timestamp)) ||
        new Date();

      const normalized = {
        eventId,
        checkoutId,
        orderId,
        type: "abandoned_checkout",
        customer,
        customerAddress: addressParts,
        customerAddressText,
        items,
        itemCount: items.length,
        currency,
        total: totalMinor,
        recoveryUrl: root.abc_url ? String(root.abc_url).trim() : undefined,
        eventAt,
        receivedAt: new Date(),
        raw: root,
        meta: {
          phoneOnly: Boolean(customer.phone) && !customer.name && !customer.email,
        },
      };

      const abandoned = isAbandoned(root, typeText);
      if (abandoned) {
        const query = normalized.eventId
          ? { eventId: normalized.eventId }
          : { checkoutId: normalized.checkoutId, eventAt: normalized.eventAt };
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

const sseClients = new Map();

function didKey(v) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

function addSseClient(did, res) {
  const key = didKey(did);
  if (!key) return;
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
}

function removeSseClient(did, res) {
  const key = didKey(did);
  const set = sseClients.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(key);
}

function sseSend(did, payload) {
  const key = didKey(did);
  const set = sseClients.get(key);
  if (!set || set.size === 0) {
    console.log("[SSE] No clients for DID", { did, key });
    return;
  }
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) { try { res.write(data); } catch { } }
  console.log("[SSE] Sent event", { key, listeners: set.size, type: payload?.type });
}

// app.use((req, res, next) => {
//   const origin = req.headers.origin;
//   if (allowedOrigins.includes(origin)) {
//     res.setHeader("Access-Control-Allow-Origin", origin);
//     res.setHeader("Access-Control-Allow-Credentials", "true");
//   }
//   res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
//   res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-agent-name, x-user-json");
//   next();
// });

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
app.use("/proxy/consultation", dietPlanProxy);

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

app.use('/api/dialer', clickToCallRoutes);

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

app.use("/api/finance", financeDashboard);

app.use('/api/orders', UndeliveredordersRoute);

app.use("/api/zoho", zohoMailRoutes);

app.use("/api/smartflo", smartfloRoutes);

app.use("/api", ReturnDeliveredRoutes);

app.use("/api/diet-templates", dietTemplatesRouter);

app.use("/api/diet-plans", dietPlansRouter);

app.use("/api/orders-shopify", ordersRouter);

app.use("/cohart-dataApi", cohartDataApiRouter);

app.use("/api", allProductsFromOrdersRoute);

app.use("/api", shopifyOrdersTable);

app.use('/api/lead-migration', leadsMigration);
app.use("/api/order-confirmations", orderConfirmationsRouter);
app.use("/api/schedule-calls", scheduleCallsRouter);

app.use("/api/ops-dashboard", opsDashboardRoutes);
app.use("/api/order-analytics", orderConfirmAnalytics);

app.use("/api/assets", assetsRoutes);
app.use("/api/asset-allotments", assetAllotmentsRoutes);
app.use("/api/asset-journey", assetJourneyRouter);
app.use("/api/orders-un", UnAssignedDelivered);

app.use('/api/bobot', bobotSyncRoutes);

app.use("/", shipmentSyncRouter);

app.use(bankTxnRouter);
app.use("/api/bank-reconciliation", bankCapital6389Routes);
app.use("/api/bank-reconciliation", bankAxis3361Routes);
app.use("/api/bank-reconciliation", bankCc1101Routes);
app.use("/api/bank-reconciliation", bankYesCcTejasvRoutes);
app.use("/api/bank-reconciliation", bankYesCcAbhayRoutes);
app.use("/api/tasks", taskBoardRoutes);
app.use("/api/tasks/reporting", taskReportingRoutes);
app.use("/api/employees", SwitchEmployee);
app.use("/api/order-confirmation", ConfirmedOrders);
app.use('/api/invoices', invoiceRoutes);

app.use("/api", globalShopifyOrders);
app.use("/api", globalAbandonedCarts);
app.use("/api/global-retention-leads", globalRetentionLeads);
app.use("/api/global-retention-sales", globalRetentionSalesRoutes);
app.use("/api/global-retention-details", globalRetentionDetails);

app.use("/api/access", accessManagementRoutes);
app.use("/api/super-admin/analytics", superAdminAnalytics);
// app.use("/api/retention", retentionAuto);

app.use("/api/vendors", vendorsRoute);
app.use("/api/purchase-records", purchaseRoute);
app.use("/api/payment-records", paymentRoute);

app.use("/api/shopify", shopifyExport);
app.use("/api/utm", utmShopifyRoutes);
app.use("/api/notifications", notificationsRoutes);

app.use("/api/whatsapp", WhatsAppRoutes);
app.use("/api/whatsapp/templates", whatsappTemplatesRoutes);
app.use("/api/whatsapp", whatsappMediaRoutes);
app.use("/api/whatsapp", whatsappAiRoutes);

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));


app.get('/api/sse', (req, res) => {
  const { did } = req.query;
  if (!did) return res.status(400).send('Missing did');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  req.socket?.setKeepAlive?.(true);
  req.socket?.setNoDelay?.(true);

  res.flushHeaders?.();

  addSseClient(String(did), res);

  const ping = setInterval(() => {
    try { res.write(':\n\n'); } catch { }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    removeSseClient(String(did), res);
    try { res.end(); } catch { }
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', did: String(did) })}\n\n`);
});


const urlencoded = bodyParser.urlencoded({ extended: false });
const jsonParser = bodyParser.json();

app.post('/api/webhooks/crm', urlencoded, jsonParser, async (req, res) => {
  try {
    const p = req.body || {};

    const uuid = p.$uuid || p.uuid || p.$UUID || p.UUID;
    const callId = p.$call_id || p.call_id;
    const didRaw = p.$call_to_number || p.call_to_number;
    const callerRaw =
      p.$caller_id_number || p.caller_id_number ||
      p.$customer_no_with_prefix || p.customer_no_with_prefix || '';

    const didKeyStr = didKey(didRaw);
    const ani = String(callerRaw || '').replace(/\D/g, '').slice(-10);

    console.log("[CRM webhook] incoming call", {
      uuid, callId, didRaw, didKey: didKeyStr, ani
    });

    let lead = null;
    if (ani) {
      lead = await Lead.findOne({
        contactNumber: { $regex: new RegExp(`${ani}$`) }
      }).select('_id name agentAssigned lastOrderDate');
    }

    const event = {
      type: 'incoming_call',
      callId: callId || uuid,
      uuid: uuid || callId,
      did: didKeyStr,
      ani,
      start_stamp: p.$start_stamp || p.start_stamp || new Date().toISOString(),
      known: !!lead,
      lead: lead ? {
        _id: String(lead._id),
        name: lead.name || '',
        agentAssigned: lead.agentAssigned || '',
        lastOrderDate: lead.lastOrderDate || ''
      } : null,
    };

    if (didKeyStr) sseSend(didKeyStr, event);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ success: false });
  }
});


const httpsAgent = new https.Agent({
  rejectUnauthorized: true,
  secureProtocol: 'TLSv1_2_method'
});

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

      const addr =
        order.shipping_address ||
        order.billing_address ||
        (order.customer && order.customer.default_address) ||
        null;

      const province = addr?.province || '';
      const provinceCode = addr?.province_code || '';

      return {
        order_id: order.name,
        name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
        contact_number: phone,
        created_at: order.created_at,
        total_price: order.total_price,
        payment_gateway_names: order.payment_gateway_names,
        line_items: order.line_items,
        channel_name: order.source_name || 'Unknown',
        delivery_status: order.fulfillment_status || 'Not Specified',
        state: province,
        state_code: provinceCode
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


const phoneLast10 = (v = "") => String(v).replace(/\D/g, "").slice(-10);


app.post('/api/leads/by-phones', async (req, res) => {
  const { phoneNumbers } = req.body;
  if (!Array.isArray(phoneNumbers)) {
    return res.status(400).json({ message: 'phoneNumbers should be an array' });
  }

  const last10List = [...new Set(phoneNumbers.map((p) => phoneLast10(p)).filter(Boolean))];
  const regexes = last10List.map((p) => new RegExp(`${p}$`));

  try {
    const leads = await Lead.find({ contactNumber: { $in: regexes } });
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
      { $sort: { order_date: -1 } },
      {
        $group: {
          _id: "$contact_number",
          mostRecentOrder: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$mostRecentOrder" } },
      { $match: { shipment_status } }
    ];

    const recentOrders = await Order.aggregate(pipeline);

    res.json(recentOrders);
  } catch (error) {
    console.error("Error fetching orders by shipment status:", error);
    res.status(500).json({ message: 'Failed to fetch orders', error: error.message });
  }
});


cron.schedule('0 8 * * *', async () => {
  try {
    const orders = await Order.find({});
    for (const order of orders) {
      try {
        if (!order.order_date) continue;

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

function normalizePhone(phone) {
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, '').replace(/^91/, '');
  return cleaned.length === 10 ? cleaned : "";
}


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

    const phoneToLeadsMap = {};

    leadsToUpdate.forEach((lead) => {
      const phone = normalizePhone(lead.contactNumber);
      if (!phone) return;
      if (!phoneToLeadsMap[phone]) phoneToLeadsMap[phone] = [];
      phoneToLeadsMap[phone].push(lead._id);
    });

    let updatedCount = 0;

    for (const phone of Object.keys(phoneToLeadsMap)) {
      console.log(`Fetching Shopify data for phone: ${phone}`);
      const firstOrderDate = await fetchShopifyFirstOrderDateByPhone(phone);

      if (firstOrderDate) {
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
    const validLeads = [];

    const contactNumbers = rows
      .map(row => row["Contact No"])
      .filter(Boolean)
      .map(num => String(num).trim());

    const existing = await Lead.find({
      contactNumber: { $in: contactNumbers }
    }).select("contactNumber");

    const existingSet = new Set(existing.map(e => e.contactNumber));

    rows.forEach((row, index) => {
      const missingFields = requiredFields.filter((field) => !row[field]);
      if (missingFields.length > 0) {
        errors.push(`Row ${index + 2} is missing mandatory fields: ${missingFields.join(", ")}`);
        return;
      }

      if (existingSet.has(String(row["Contact No"]).trim())) {
        errors.push(`Row ${index + 2} skipped - contact number already exists`);
        return;
      }

      validLeads.push({
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
      });
    });

    if (errors.length > 0 && validLeads.length === 0) {
      return res.status(400).json({ success: false, error: errors.join(". ") });
    }

    if (validLeads.length > 0) {
      await Lead.insertMany(validLeads);
    }

    res.json({ success: true, skipped: errors, inserted: validLeads.length });
  } catch (err) {
    console.error("Error processing file:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


app.get('/api/leads/check-duplicate', async (req, res) => {
  const { contactNumber } = req.query;

  try {
    const last10 = phoneLast10(contactNumber);
    const lead = await Lead.findOne({ contactNumber: { $regex: new RegExp(`${last10}$`) } });

    if (lead) {
      return res.status(200).json({ exists: true, leadId: lead._id });
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
    if (req.body.contactNumber) {
      req.body.contactNumber = phoneLast10(req.body.contactNumber);
    }

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
    if (req.body.contactNumber) {
      req.body.contactNumber = phoneLast10(req.body.contactNumber);
    }

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
    const deletedLead = await Lead.findByIdAndDelete(req.params.id);
    if (!deletedLead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
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

    let match = { salesStatus: "Sales Done" };

    if (retentionStatus && retentionStatus !== "All") {
      match.retentionStatus = retentionStatus;
    }

    if (search && search.trim() !== "") {
      const s = search.trim();
      match.$or = [
        { name: { $regex: s, $options: "i" } },
        { contactNumber: { $regex: s, $options: "i" } },
        { orderId: { $regex: s, $options: "i" } },
      ];
    }

    if (agentAssigned) {
      let arr = Array.isArray(agentAssigned)
        ? agentAssigned
        : agentAssigned.split(",");
      match.agentAssigned = { $in: arr };
    }

    if (healthExpertAssigned) {
      let arr = Array.isArray(healthExpertAssigned)
        ? healthExpertAssigned
        : healthExpertAssigned.split(",");
      match.healthExpertAssigned = { $in: arr };
    }

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
                  ],
                },
                then: "NotSet",
              },
            ],
            default: {
              $let: {
                vars: {
                  dYmd: {
                    $dateFromString: {
                      dateString: "$rtNextFollowupDate",
                      format: "%Y-%m-%d",
                      onError: null,
                      onNull: null,
                    },
                  },
                  dGeneral: {
                    $dateFromString: {
                      dateString: "$rtNextFollowupDate",
                      onError: null,
                      onNull: null,
                    },
                  },
                  excelDays: {
                    $cond: [
                      {
                        $or: [
                          { $and: [{ $isNumber: "$rtNextFollowupDate" }, { $lte: ["$rtNextFollowupDate", 100000] }] },
                          {
                            $and: [
                              { $eq: [{ $type: "$rtNextFollowupDate" }, "string"] },
                              { $regexMatch: { input: "$rtNextFollowupDate", regex: /^[0-9]{4,6}$/ } }
                            ]
                          }
                        ]
                      },
                      { $toInt: "$rtNextFollowupDate" },
                      null
                    ]
                  },
                  todayIST: {
                    $dateTrunc: {
                      date: "$$NOW",
                      unit: "day",
                      timezone: "Asia/Kolkata",
                    },
                  }
                },
                in: {
                  $let: {
                    vars: {
                      followupDate: {
                        $cond: [
                          { $ne: ["$$dYmd", null] }, "$$dYmd",
                          {
                            $cond: [
                              { $ne: ["$$dGeneral", null] }, "$$dGeneral",
                              {
                                $cond: [
                                  { $ne: ["$$excelDays", null] },
                                  {
                                    $dateAdd: {
                                      startDate: { $toDate: "1899-12-30T00:00:00Z" },
                                      unit: "day",
                                      amount: "$$excelDays",
                                    }
                                  },
                                  null
                                ]
                              }
                            ]
                          }
                        ]
                      }
                    },
                    in: {
                      $cond: [
                        { $eq: ["$$followupDate", null] },
                        "NotSet",
                        {
                          $let: {
                            vars: {
                              d: {
                                $dateDiff: {
                                  startDate: "$$todayIST",
                                  endDate: "$$followupDate",
                                  unit: "day",
                                  timezone: "Asia/Kolkata",
                                }
                              }
                            },
                            in: {
                              $switch: {
                                branches: [
                                  { case: { $lt: ["$$d", 0] }, then: "Missed" },
                                  { case: { $eq: ["$$d", 0] }, then: "Today" },
                                  { case: { $eq: ["$$d", 1] }, then: "Tomorrow" },
                                ],
                                default: "Later"
                              }
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

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

    const statusCountsPromise = Lead.aggregate([
      { $match: { salesStatus: "Sales Done" } },
      {
        $group: {
          _id: { $ifNull: ["$retentionStatus", "Active"] },
          count: { $sum: 1 },
        }
      }
    ]);

    let mainPipeline = [
      { $match: match },
      addFieldsStage
    ];

    if (followup) {
      mainPipeline.push({ $match: { calculatedReminder: followup } });
    }

    mainPipeline.push(
      { $sort: { lastOrderDate: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    );

    let [leads, followupCountsArr, statusCountsArr] = await Promise.all([
      Lead.aggregate(mainPipeline),
      Lead.aggregate(countPipeline),
      statusCountsPromise,
    ]);

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

    const counts = { Today: 0, Tomorrow: 0, Missed: 0, Later: 0, NotSet: 0 };
    for (const f of followupCountsArr) {
      counts[f._id] = f.count;
    }

    let topCounts = { All: 0, Active: 0, Lost: 0 };
    let total = 0;
    for (const s of statusCountsArr) {
      let key = s._id === "Lost" ? "Lost" : "Active";
      if (s._id === "Lost") topCounts.Lost = s.count;
      else topCounts.Active += s.count;
      total += s.count;
    }
    topCounts.All = total;

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

  const IST_TZ = 'Asia/Kolkata';

  const startOfISTDay = (d = new Date()) => {
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    return new Date(`${ymd}T00:00:00+05:30`);
  };
  const shiftDaysIST = (date, days) => new Date(date.getTime() + days * 86400000);

  const startTodayIST_UTC = startOfISTDay();
  const startTomorrowIST_UTC = shiftDaysIST(startTodayIST_UTC, 1);
  const startDayAfterIST_UTC = shiftDaysIST(startTodayIST_UTC, 2);

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const strToDateExprFor = (field) => ({
    $let: {
      vars: { s: `$${field}` },
      in: {
        $switch: {
          branches: [
            {
              case: { $regexMatch: { input: '$$s', regex: '^\\d{4}-\\d{2}-\\d{2}$' } },
              then: { $dateFromString: { dateString: { $concat: ['$$s', 'T00:00:00+05:30'] } } }
            },
            {
              case: { $regexMatch: { input: '$$s', regex: '^\\d{1,2}/\\d{1,2}/\\d{4}$' } },
              then: { $dateFromString: { dateString: '$$s', format: '%d/%m/%Y', timezone: IST_TZ } }
            },
            {
              case: { $regexMatch: { input: '$$s', regex: '^\\d{1,2}-\\d{1,2}-\\d{4}$' } },
              then: { $dateFromString: { dateString: '$$s', format: '%d-%m-%Y', timezone: IST_TZ } }
            },
            {
              case: { $regexMatch: { input: '$$s', regex: 'T\\d{2}:\\d{2}:\\d{2}' } },
              then: { $dateFromString: { dateString: '$$s' } }
            },
          ],
          default: { $dateFromString: { dateString: '9999-12-31T00:00:00+05:30' } }
        }
      }
    }
  });

  const isDateField = (field) => ({ [field]: { $type: 'date' } });
  const isStringField = (field) => ({ [field]: { $type: 'string' } });

  const stringLT = (field, b) => ({ $and: [isStringField(field), { $expr: { $lt: [strToDateExprFor(field), b] } }] });
  const stringGTE = (field, b) => ({ $and: [isStringField(field), { $expr: { $gte: [strToDateExprFor(field), b] } }] });
  const stringInRange = (field, g, l) => ({ $and: [isStringField(field), { $expr: { $and: [{ $gte: [strToDateExprFor(field), g] }, { $lt: [strToDateExprFor(field), l] }] } }] });
  const dateLT = (field, b) => ({ $and: [isDateField(field), { [field]: { $lt: b } }] });
  const dateGTE = (field, b) => ({ $and: [isDateField(field), { [field]: { $gte: b } }] });
  const dateInRange = (field, g, l) => ({ $and: [isDateField(field), { [field]: { $gte: g, $lt: l } }] });

  try {
    const {
      page: pageRaw,
      limit: limitRaw,
      retentionStatus = 'All',
      followupCategory,
      search: searchRaw,
      followupDate: followupDateStr,
      serial: serialRaw,
      rowColor,
      acquiredYear,
      acquiredMonth,
    } = req.query;

    const page = Math.max(parseInt(pageRaw ?? '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10), 1), 500);

    const serial = serialRaw != null && /^\d+$/.test(String(serialRaw))
      ? Math.max(parseInt(String(serialRaw), 10) - 1, 0)
      : null;

    let skip = (page - 1) * limit;
    if (serial != null) skip = serial;

    const notsetCond = { $or: [{ rtNextFollowupDate: { $exists: false } }, { rtNextFollowupDate: null }, { rtNextFollowupDate: '' }] };
    const missedCond = { $or: [dateLT('rtNextFollowupDate', startTodayIST_UTC), stringLT('rtNextFollowupDate', startTodayIST_UTC)] };
    const todayCond = { $or: [dateInRange('rtNextFollowupDate', startTodayIST_UTC, startTomorrowIST_UTC), stringInRange('rtNextFollowupDate', startTodayIST_UTC, startTomorrowIST_UTC)] };
    const tomorrowCond = { $or: [dateInRange('rtNextFollowupDate', startTomorrowIST_UTC, startDayAfterIST_UTC), stringInRange('rtNextFollowupDate', startTomorrowIST_UTC, startDayAfterIST_UTC)] };
    const laterCond = { $or: [dateGTE('rtNextFollowupDate', startDayAfterIST_UTC), stringGTE('rtNextFollowupDate', startDayAfterIST_UTC)] };

    let followScope = null;
    if (followupCategory) {
      const cat = String(followupCategory).toLowerCase();
      if (cat === 'notset') followScope = notsetCond;
      if (cat === 'missed') followScope = missedCond;
      if (cat === 'today') followScope = todayCond;
      if (cat === 'tomorrow') followScope = tomorrowCond;
      if (cat === 'later') followScope = laterCond;
    }

    let followupOnScope = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(followupDateStr ?? '')) {
      const dayStartIST = new Date(`${followupDateStr}T00:00:00+05:30`);
      const nextDayIST = new Date(dayStartIST.getTime() + 86400000);
      followupOnScope = {
        $or: [dateInRange('rtNextFollowupDate', dayStartIST, nextDayIST), stringInRange('rtNextFollowupDate', dayStartIST, nextDayIST)]
      };
    }

    let acquiredScope = null;
    const y = acquiredYear && /^\d{4}$/.test(String(acquiredYear)) ? parseInt(acquiredYear, 10) : null;
    const m = acquiredMonth && /^\d{1,2}$/.test(String(acquiredMonth)) ? Math.min(Math.max(parseInt(acquiredMonth, 10), 1), 12) : null;

    if (y && m) {
      const monthStartIST = new Date(`${String(y)}-${String(m).padStart(2, '0')}-01T00:00:00+05:30`);
      const monthEndIST = new Date(new Date(monthStartIST).setMonth(monthStartIST.getMonth() + 1));
      acquiredScope = {
        $or: [
          dateInRange('lastOrderDate', monthStartIST, monthEndIST),
          stringInRange('lastOrderDate', monthStartIST, monthEndIST),
        ]
      };
    }

    let colorScope = null;
    if (rowColor !== undefined) {
      if (rowColor === '') {
        colorScope = { $or: [{ rowColor: { $exists: false } }, { rowColor: '' }, { rowColor: null }] };
      } else {
        colorScope = { rowColor: String(rowColor) };
      }
    }

    const search = (searchRaw ?? '').toString().trim();
    let searchScope = null;
    if (search) {
      const safe = escapeRegex(search);
      const isDigits = /^\d+$/.test(search);
      if (isDigits && search.length >= 7) {
        searchScope = { contactNumber: { $regex: safe } };
      } else {
        searchScope = {
          $or: [
            { name: { $regex: safe, $options: 'i' } },
            { contactNumber: { $regex: safe } },
          ],
        };
      }
    }

    const blankOrNullPieces = [
      { retentionStatus: { $exists: false } },
      { retentionStatus: null },
      { retentionStatus: '' },
    ];
    const ACTIVE_REGEX = /^\s*active\s*$/i;
    const LOST_REGEX = /^\s*lost\s*$/i;
    const NO_CALL_REGEX = /^\s*no[-\s]*call\s*$/i;

    let retentionScope;
    const rs = String(retentionStatus || 'All').toLowerCase();

    if (rs === 'active') {
      retentionScope = {
        $and: [
          { $or: [{ retentionStatus: ACTIVE_REGEX }, ...blankOrNullPieces] },
          { $nor: [{ retentionStatus: LOST_REGEX }, { retentionStatus: NO_CALL_REGEX }] },
        ],
      };
    } else if (rs === 'lost') {
      retentionScope = { retentionStatus: LOST_REGEX };
    } else if (rs === 'no-call' || rs === 'nocall' || rs === 'no call') {
      retentionScope = { retentionStatus: NO_CALL_REGEX };
    } else {
      retentionScope = {
        $or: [{ retentionStatus: ACTIVE_REGEX }, { retentionStatus: LOST_REGEX }, { retentionStatus: NO_CALL_REGEX }, ...blankOrNullPieces],
      };
    }

    const common = {
      healthExpertAssigned: { $in: [fullName, `${fullName} (${email})`] },
      salesStatus: 'Sales Done',
    };

    const base = {
      ...common,
      $and: [
        retentionScope,
        ...(followScope ? [followScope] : []),
        ...(followupOnScope ? [followupOnScope] : []),
        ...(acquiredScope ? [acquiredScope] : []),
        ...(colorScope ? [colorScope] : []),
        ...(searchScope ? [searchScope] : []),
      ],
    };

    const projection = {
      name: 1, contactNumber: 1, alternativeNumber: 1, retentionStatus: 1, rtNextFollowupDate: 1,
      rtFollowupReminder: 1, rtFollowupStatus: 1, lastOrderDate: 1, rowColor: 1,
      agentAssigned: 1, preferredLanguage: 1, communicationMethod: 1, rtRemark: 1,
      reachoutLogs: 1, rtSubcells: 1,
    };

    const sort = { lastOrderDate: -1, _id: -1 };

    const query = Lead.find(base, projection)
      .read('secondaryPreferred')
      .sort(sort).skip(skip).limit(limit)
      .slice('reachoutLogs', -5)
      .lean();

    const countsBase = { ...common };
    const countsScope =
      rs === 'active'
        ? {
            $and: [
              { $or: [{ retentionStatus: ACTIVE_REGEX }, ...blankOrNullPieces] },
              { $nor: [{ retentionStatus: LOST_REGEX }, { retentionStatus: NO_CALL_REGEX }] },
            ],
          }
        : rs === 'lost'
        ? { retentionStatus: LOST_REGEX }
        : rs === 'no-call' || rs === 'nocall' || rs === 'no call'
        ? { retentionStatus: NO_CALL_REGEX }
        : {
            $or: [
              { retentionStatus: ACTIVE_REGEX },
              { retentionStatus: LOST_REGEX },
              { retentionStatus: NO_CALL_REGEX },
              ...blankOrNullPieces,
            ],
          };
    const notsetCountQ = { ...countsBase, ...countsScope, ...notsetCond };
    const missedCountQ = { ...countsBase, ...countsScope, ...missedCond };
    const todayCountQ = { ...countsBase, ...countsScope, ...todayCond };
    const tomorrowCountQ = { ...countsBase, ...countsScope, ...tomorrowCond };
    const laterCountQ = { ...countsBase, ...countsScope, ...laterCond };

    const totalAllQ = { ...common, $or: [{ retentionStatus: ACTIVE_REGEX }, { retentionStatus: LOST_REGEX }, { retentionStatus: NO_CALL_REGEX }, ...blankOrNullPieces] };
    const totalActiveQ = { ...common, $and: [{ $or: [{ retentionStatus: ACTIVE_REGEX }, ...blankOrNullPieces] }, { $nor: [{ retentionStatus: LOST_REGEX }, { retentionStatus: NO_CALL_REGEX }] }] };
    const totalLostQ = { ...common, retentionStatus: LOST_REGEX };
    const totalNoCallQ = { ...common, retentionStatus: NO_CALL_REGEX };

    const [
      items, total,
      cAll, cActive, cLost, cNoCall,
      cNotset, cMissed,
      cToday, cTomorrow, cLater
    ] = await Promise.all([
      query.exec(),
      Lead.countDocuments(base),
      Lead.countDocuments(totalAllQ),
      Lead.countDocuments(totalActiveQ),
      Lead.countDocuments(totalLostQ),
      Lead.countDocuments(totalNoCallQ),
      Lead.countDocuments(notsetCountQ),
      Lead.countDocuments(missedCountQ),
      Lead.countDocuments(todayCountQ),
      Lead.countDocuments(tomorrowCountQ),
      Lead.countDocuments(laterCountQ),
    ]);

    const effectiveSkip = skip;
    const shown = Math.min(limit, Math.max(total - effectiveSkip, 0));
    const hasMore = effectiveSkip + shown < total;

    res.status(200).json({
      items, total, page, limit,
      serialStart: effectiveSkip + 1,
      hasMore,
      counts: {
        all: cAll, active: cActive, lost: cLost, nocall: cNoCall,
        followups: { notset: cNotset, missed: cMissed, today: cToday, tomorrow: cTomorrow, later: cLater },
      },
    });
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

    lead.images = images;
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

    const pageNumber = parseInt(page, 10);
    const limitNumber = parseInt(limit, 10);
    const skip = (pageNumber - 1) * limitNumber;

    const total = await Lead.countDocuments(query);

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

    const customer = await Customer.findOne({ phone: contactNumber });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const consultations = await ConsultationDetails.find({ customerId: customer._id }).sort({ createdAt: -1 });

    res.json({ consultations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});