require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require("multer");
const path = require('path');
const Lead = require('./models/Lead');
const XLSX = require("xlsx");
const axios = require('axios');
const https = require('https'); 
const cron = require('node-cron');
const TransferRequest = require('./models/TransferRequests');
const shopifyProductsRoute = require("./services/shopifyProducts");
const shopifyOrdersRoute = require("./services/shopifyOrders");
const ShopifyPush = require("./services/ShopifyPush");
const razorpayRoutes = require("./services/razorpay");
const shopifyRoutes = require("./routes/shopifyRoutes");
const templateRoutes = require("./routes/templates");
const exportLeadsRouter = require('./routes/exportLeads');
const retentionSalesRoutes = require('./routes/retentionSalesRoutes');
const Order = require('./models/Order');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());  

app.use("/api/templates", templateRoutes);
app.use("/api/shopify", shopifyProductsRoute);
app.use("/api/shopify", shopifyOrdersRoute);
app.use("/api/shopify", ShopifyPush);
app.use("/api/razorpay", razorpayRoutes); 
app.use("/api/shopify", shopifyRoutes);

app.use(retentionSalesRoutes);

app.use('/', exportLeadsRouter);
 
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));
 
const EmployeeSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  callerId: { type: String, required: true },
  role: { type: String, required: true },
  password: { type: String, required: true },
  agentNumber: { type: String, required: true },
  async: { type: Number, default: 1 },
  status: { type: String, default: "active" },
});

// Create Employee model
const Employee = mongoose.model('Employee', EmployeeSchema);

// const RetentionSalesSchema = new mongoose.Schema({
//   date: String,
//   name: String,
//   contactNumber: String,
//   productsOrdered: [String],
//   dosageOrdered: { type: String, default: "" },
//   amountPaid: Number,
//   modeOfPayment: String,
//   orderId: String, 
//   shopify_amount: String,  
//   shipway_status: String,  
//   orderCreatedBy: String,
//   remarks: String, 
// });
 
// const RetentionSales = mongoose.model("RetentionSales", RetentionSalesSchema);

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
 
    const fetchedOrders = response.data.orders.map(order => ({
      order_id: order.name,  
      name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
      contact_number: order.customer && order.customer.default_address 
        ? order.customer.default_address.phone.replace(/^\+91/, '').trim()
        : '',
      created_at: order.created_at,           
      total_price: order.total_price,         
      payment_gateway_names: order.payment_gateway_names, 
      line_items: order.line_items,           
      channel_name: order.source_name || 'Unknown',
      delivery_status: order.fulfillment_status || 'Not Specified' 
    }));

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
    console.error('Failed to fetch orders:', error);
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
 
  const start = startDate ? new Date(startDate).toISOString() : defaultStartDate;
  const end = endDate ? new Date(endDate).toISOString() : defaultEndDate;

  const startEncoded = encodeURIComponent(start);
  const endEncoded = encodeURIComponent(end);

  const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=${startEncoded}&created_at_max=${endEncoded}&limit=250`;
    
  try {
    const orders = await fetchAllOrders(shopifyAPIEndpoint, process.env.SHOPIFY_API_SECRET);
    
    // For each Shopify order, normalize the order_id (remove "#" if present) 
    // and attach the shipment status from the Shipway database.
    const ordersWithShipwayStatus = await Promise.all(orders.map(async (order) => {
      const normalizedOrderId = order.order_id.startsWith('#')
        ? order.order_id.slice(1)
        : order.order_id;
      const shipwayOrder = await Order.findOne({ order_id: normalizedOrderId });
      order.shipway_status = shipwayOrder ? shipwayOrder.shipment_status : "Not available";
      return order;
    }));

    res.json(ordersWithShipwayStatus);
  } catch (error) {
    console.error('Error fetching orders from Shopify:', error.response ? error.response.data : error);
    res.status(500).send('Failed to fetch orders');
  }
});[]


// Define the Order schema and model (storing order_id, shipment_status, and order_date for filtering)
// const orderSchema = new mongoose.Schema({
//   order_id: { type: String, required: true, unique: true },
//   shipment_status: { type: String, required: true },
//   order_date: { type: Date }  
// }, { timestamps: true });

// const Order = mongoose.model('Order', orderSchema);

// Shipment status mapping (abbreviation to full text)
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
  console.log(`Syncing orders from Shipway API for date range ${startDate} to ${endDate}...`);
  let page = 1;
  let totalFetched = 0;
  const rowsPerPage = 100;  

  while (true) {
    try {
      const orders = await fetchOrdersFromShipway(page, startDate, endDate);
      if (!orders || orders.length === 0) {
        break;
      }
      for (const order of orders) {
        const orderId = order.order_id;
        const shipmentStatus = statusMapping[order.shipment_status] || order.shipment_status;
        const orderDate = order.order_date ? new Date(order.order_date) : null; 
        await Order.updateOne(
          { order_id: orderId },
          { order_id: orderId, shipment_status: shipmentStatus, order_date: orderDate },
          { upsert: true }
        );
      }
      totalFetched += orders.length; 
      if (orders.length < rowsPerPage) {
        break;
      }
      page++;
    } catch (error) { 
      break;
    }
  } 
  return totalFetched;
};
 
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
    await Order.updateOne(
      { order_id },
      { order_id, shipment_status: status, order_date: date },
      { upsert: true }
    );
    res.json({ message: "Order saved/updated" });
  } catch (error) { 
    res.status(500).json({ message: "Error saving new order", error: error.message });
  }
});
 
cron.schedule('0 * * * *', async () => { 
  try {
    const orders = await Order.find({});
    for (const order of orders) {
      try { 
        if (!order.order_date) continue;
        const page = 1;
        const dateStr = order.order_date.toISOString().split("T")[0];
        const ordersFromShipway = await fetchOrdersFromShipway(page, dateStr, dateStr);
        const updatedOrder = ordersFromShipway.find(o => o.order_id === order.order_id);
        if (updatedOrder) {
          const shipmentStatus = statusMapping[updatedOrder.shipment_status] || updatedOrder.shipment_status;
          await Order.updateOne({ order_id: order.order_id }, { shipment_status: shipmentStatus });
        }
      } catch (err) { 
      }
    }
  } catch (error) { 
  }
});
  
// app.get('/api/retention-sales', async (req, res) => {
//   const { orderCreatedBy } = req.query;

//   try {
//     // 1. Fetch retention sales (filtered by orderCreatedBy if provided)
//     let retentionSales;
//     if (orderCreatedBy) {
//       retentionSales = await RetentionSales.find({ orderCreatedBy }).sort({ date: -1 });
//     } else {
//       retentionSales = await RetentionSales.find({}).sort({ date: -1 });
//     }

//     if (retentionSales.length === 0) {
//       return res.status(200).json([]);
//     }

//     // 2. Determine overall date range from retention sales
//     const dates = retentionSales.map((sale) => new Date(sale.date));
//     const minDate = new Date(Math.min(...dates));
//     const maxDate = new Date(Math.max(...dates));

//     // Expand the range slightly (one day on each side)
//     const startDate = new Date(minDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
//     const endDate = new Date(maxDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

//     // 3. Build Shopify API URL
//     const startEncoded = encodeURIComponent(startDate);
//     const endEncoded = encodeURIComponent(endDate);
//     const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=${startEncoded}&created_at_max=${endEncoded}&limit=250`;

//     // Helper function to recursively fetch all Shopify orders
//     const fetchAllOrders = async (url, allOrders = []) => {
//       try {
//         const response = await axios.get(url, {
//           headers: {
//             'X-Shopify-Access-Token': process.env.SHOPIFY_API_SECRET,
//             'Content-Type': 'application/json',
//           },
//         });

//         if (!response.data.orders) {
//           return allOrders;
//         }

//         allOrders = allOrders.concat(response.data.orders);

//         const nextLinkHeader = response.headers.link;
//         if (nextLinkHeader) {
//           const match = nextLinkHeader.match(/<([^>]+)>;\s*rel="next"/);
//           if (match && match[1]) {
//             return fetchAllOrders(match[1], allOrders);
//           }
//         }
//         return allOrders;
//       } catch (err) {
//         console.error('Error fetching Shopify orders:', err);
//         return allOrders;
//       }
//     };

//     // 4. Fetch all Shopify orders in this date range
//     const shopifyOrders = await fetchAllOrders(shopifyAPIEndpoint);

//     // 5. Normalization helper for phone numbers
//     const normalizePhoneNumber = (phone) => {
//       if (!phone) return "";
//       let digits = phone.replace(/\D/g, "");
//       if (digits.length > 10 && digits.startsWith("91")) {
//         digits = digits.slice(2);
//       }
//       if (digits.length === 11 && digits.startsWith("0")) {
//         digits = digits.slice(1);
//       }
//       return digits;
//     };

//     // 6. Iterate over each retention sale and update if needed
//     const updatedSales = await Promise.all(
//       retentionSales.map(async (sale) => {
//         // If sale.orderId is already a valid ID (not containing "mismatch" & not empty),
//         // we skip the matching logic unless you want to always re-check.
//         if (sale.orderId && !sale.orderId.includes("mismatch")) {
//           // Optionally, you might still want to refresh shipway_status here:
//           const normalizedOrderId = sale.orderId.startsWith("#")
//             ? sale.orderId.slice(1)
//             : sale.orderId;
//           const shipwayOrder = await Order.findOne({ order_id: normalizedOrderId }).lean();
//           const newShipwayStatus = shipwayOrder ? shipwayOrder.shipment_status : "Not available";

//           // If the status changed, update it:
//           if (sale.shipway_status !== newShipwayStatus) {
//             sale.shipway_status = newShipwayStatus;
//             await RetentionSales.findByIdAndUpdate(sale._id, {
//               shipway_status: sale.shipway_status,
//             });
//           }

//           // Return as-is (already matched)
//           return sale;
//         }

//         // Otherwise, we attempt to match with Shopify
//         const saleDateStr = sale.date; // e.g. "2025-02-05"
//         const saleDate = new Date(saleDateStr);
//         const nextDay = new Date(saleDate.getTime() + 24 * 60 * 60 * 1000);
//         const normalizedSalePhone = normalizePhoneNumber(sale.contactNumber);

//         // Filter Shopify orders within that day range
//         const ordersInDate = shopifyOrders.filter((order) => {
//           const orderDate = new Date(order.created_at);
//           return orderDate >= saleDate && orderDate < nextDay;
//         });

//         // 6a. Full match: phone + date
//         let fullMatch = ordersInDate.find((order) => {
//           const shopifyPhone =
//             order.customer && order.customer.default_address
//               ? order.customer.default_address.phone
//               : "";
//           return normalizePhoneNumber(shopifyPhone) === normalizedSalePhone;
//         });

//         if (fullMatch) {
//           sale.orderId = fullMatch.name; // e.g. "#MA40491"
//           sale.shopify_amount = fullMatch.total_price;

//           // Check Shipway status
//           const normalizedOrderId = sale.orderId.startsWith("#")
//             ? sale.orderId.slice(1)
//             : sale.orderId;
//           const shipwayOrder = await Order.findOne({ order_id: normalizedOrderId }).lean();
//           sale.shipway_status = shipwayOrder ? shipwayOrder.shipment_status : "Not available";
//         } else {
//           // 6b. Phone-only match across all Shopify orders
//           let phoneMatch = shopifyOrders.find((order) => {
//             const shopifyPhone =
//               order.customer && order.customer.default_address
//                 ? order.customer.default_address.phone
//                 : "";
//             return normalizePhoneNumber(shopifyPhone) === normalizedSalePhone;
//           });

//           if (phoneMatch) {
//             sale.orderId = "date mismatch";
//           } else if (ordersInDate.length > 0) {
//             sale.orderId = "phone mismatch";
//           } else {
//             sale.orderId = "phone and date mismatch";
//           }
//           sale.shopify_amount = "";
//           sale.shipway_status = "";
//         }

//         // 7. Persist the new values in MongoDB
//         await RetentionSales.findByIdAndUpdate(sale._id, {
//           orderId: sale.orderId,
//           shopify_amount: sale.shopify_amount,
//           shipway_status: sale.shipway_status,
//         });

//         return sale;
//       })
//     );

//     // 8. Return the updated array of sales
//     return res.status(200).json(updatedSales);
//   } catch (error) {
//     console.error("Error fetching retention sales:", error);
//     return res.status(500).json({ message: "Error fetching retention sales", error });
//   }
// });
 

// app.post('/api/retention-sales', async (req, res) => {
//   const {
//     date,
//     name = "",
//     contactNumber = "",
//     productsOrdered = [],
//     dosageOrdered = "",
//     amountPaid = 0, 
//     modeOfPayment = "Not Specified",  
//     orderCreatedBy,
//     remarks = "", 
//     orderId = "",
//     shopify_amount = "",
//     shipway_status = ""
//   } = req.body;

//   if (!date || !orderCreatedBy) {
//     return res.status(400).json({ message: "Date and orderCreatedBy are required." });
//   }

//   try {
//     const newSale = new RetentionSales({
//       date,
//       name,
//       contactNumber,
//       productsOrdered,
//       dosageOrdered,
//       amountPaid,
//       modeOfPayment, 
//       orderCreatedBy,
//       remarks,
//       orderId,
//       shopify_amount,
//       shipway_status
//     });

//     await newSale.save();
//     res.status(201).json(newSale);
//   } catch (error) {
//     console.error('Error adding retention sale:', error);
//     res.status(500).json({ message: 'Error adding retention sale', error });
//   }
// });


// app.put('/api/retention-sales/:id', async (req, res) => {
//   const { id } = req.params;

//   try {
//     const updatedSale = await RetentionSales.findByIdAndUpdate(id, req.body, {
//       new: true,
//     });

//     if (!updatedSale) {
//       return res.status(404).json({ message: 'Sale not found' });
//     }

//     res.status(200).json(updatedSale); 
//   } catch (error) {
//     console.error('Error updating retention sale:', error);
//     res.status(500).json({ message: 'Error updating retention sale', error });
//   }
// });

 
// app.delete('/api/retention-sales/:id', async (req, res) => {
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


app.get("/api/employees", async (req, res) => {
  const { role, fullName, email } = req.query;

  try {
    if (fullName && email) { 
      const employee = await Employee.findOne({ fullName, email });

      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const { async, agentNumber, callerId } = employee;
      return res.status(200).json([{ async, agentNumber, callerId }]);  
    }
 
    const query = role ? { role } : {};
    const employees = await Employee.find(query, "fullName email callerId agentNumber async role status");

    res.status(200).json(employees);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ message: "Error fetching employees", error });
  }
});



app.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await Employee.findByIdAndDelete(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    const employees = await Employee.find({}, '-password');  
    res.status(200).json({ message: 'Employee deleted successfully', employees });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting employee', error });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const { callerId, agentNumber, password, ...updateData } = req.body;  

  try { 
    if (password) {
      updateData.password = password;
    }
 
    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { callerId, agentNumber, async: 1, ...updateData }, 
      {
        new: true, 
        runValidators: true, 
      }
    );

    if (!updatedEmployee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
 
    res.status(200).json({
      message: 'Employee updated successfully',
      employee: updatedEmployee,
    }); 
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ message: 'Error updating employee', error });
  }
});


app.post('/api/employees', async (req, res) => {
  const { fullName, email, callerId, agentNumber, role, password } = req.body;
 
  if (!fullName || !email || !callerId || !agentNumber || !role || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try { 
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Email already exists.' });
    }
 
    const newEmployee = new Employee({
      fullName,
      email,
      callerId, 
      agentNumber,
      role,
      password,
      async: 1,
    });

    await newEmployee.save();
    res.status(201).json({ message: 'Employee added successfully', employee: newEmployee });
  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ message: 'Error adding employee', error });
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
  const { page = 1, limit = 30, filters = '{}', agentAssignedName, salesStatus } = req.query;
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
  

    // Order Date
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
    const deletedLead = await Lead.findByIdAndDelete(req.params.id);
    if (!deletedLead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.status(200).json({ message: 'Lead deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting lead', error });
  }
}); 

 
app.get('/api/leads/retention', async (req, res) => { 
  const { page, limit, all, fullName } = req.query;
 
  let query = { salesStatus: "Sales Done" };
  if (fullName) { 
    query.healthExpertAssigned = fullName;
  }
 
  const calculateReminder = (nextFollowupDate) => {
    const today = new Date();
    const followupDate = new Date(nextFollowupDate);
    const diffInDays = Math.ceil((followupDate - today) / (1000 * 60 * 60 * 24));
    if (diffInDays < 0) return "Follow-up Missed";
    if (diffInDays === 0) return "Today";
    if (diffInDays === 1) return "Tomorrow";
    return "Later";
  };

  try { 
    if (all === "true") {
      const leads = await Lead.find(query, {
        name: 1,
        contactNumber: 1,
        agentAssigned: 1,
        productPitched: 1,
        agentsRemarks: 1,
        productsOrdered: 1,
        dosageOrdered: 1,
        modeOfPayment: 1,
        deliveryStatus: 1,
        healthExpertAssigned: 1,
        dosageExpiring: 1,
        rtNextFollowupDate: 1,
        rtFollowupReminder: 1,
        rtFollowupStatus: 1,
        lastOrderDate: 1,
        repeatDosageOrdered: 1,
        retentionStatus: 1,
        rtRemark: 1,
      }).sort({ _id: -1 });
      const leadsWithReminder = leads.map((lead) => ({
        ...lead._doc,
        rtFollowupReminder: calculateReminder(lead.rtNextFollowupDate),
      }));

      return res.status(200).json({
        leads: leadsWithReminder,
        totalLeads: leadsWithReminder.length,
        totalPages: 1,
        currentPage: 1,
      });
    } else {
      // Use pagination if "all" is not true
      const pageNumber = parseInt(page) || 1;
      const limitNumber = parseInt(limit) || 50;
      const skip = (pageNumber - 1) * limitNumber;

      const totalLeads = await Lead.countDocuments(query);
      const leads = await Lead.find(query, {
        name: 1,
        contactNumber: 1,
        agentAssigned: 1,
        productPitched: 1,
        agentsRemarks: 1,
        productsOrdered: 1,
        dosageOrdered: 1,
        modeOfPayment: 1,
        deliveryStatus: 1,
        healthExpertAssigned: 1,
        dosageExpiring: 1,
        rtNextFollowupDate: 1,
        rtFollowupReminder: 1,
        rtFollowupStatus: 1,
        lastOrderDate: 1,
        repeatDosageOrdered: 1,
        retentionStatus: 1,
        rtRemark: 1,
      })
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limitNumber);

      const leadsWithReminder = leads.map((lead) => ({
        ...lead._doc,
        rtFollowupReminder: calculateReminder(lead.rtNextFollowupDate),
      }));

      return res.status(200).json({
        leads: leadsWithReminder,
        totalLeads,
        totalPages: Math.ceil(totalLeads / limitNumber),
        currentPage: pageNumber,
      });
    }
  } catch (error) {
    console.error("Error in retention endpoint:", error.message);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
});


app.get('/api/leads/retentions', async (req, res) => {
  const { fullName, email } = req.query;  

  if (!fullName || !email) {
    return res.status(400).json({ message: 'Full name and email are required' });
  }

  try {
    // Match either the exact fullName or the combined format
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


app.get('/api/leads/new-orders', async (req, res) => {
  try {
    // Extract page, limit, and other filter parameters from query
    const { page = 1, limit = 30, ...filters } = req.query;
    
    // Build the query with default filter and exclusion for Admin/Online Order
    const query = { 
      salesStatus: "Sales Done",
      agentAssigned: { $nin: ['Admin', 'Online Order'] }
    };

    // Apply additional filters if provided
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
      // This will override our $nin if provided, so merge carefully if needed
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
 

// Login Route
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Find user by email
    const user = await Employee.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password." });
    }
 
    if (user.password !== password) {
      return res.status(400).json({ message: "Invalid email or password." });
    }

    // Prevent login if employee is inactive
    if (user.status !== "active") {
      return res.status(403).json({ message: "Inactive employees are not allowed to login." });
    }
 
    res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,  
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error. Please try again later." });
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
 
// Search endpoint
app.get('/api/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ message: "Query is required" });
  }

  try {
    const results = await Lead.find({
      $or: [
        { name: { $regex: query, $options: "i" } },
        { contactNumber: { $regex: query } }
      ],
    }).limit(10);  

    res.status(200).json(results);
  } catch (error) {
    console.error("Error during search:", error);
    res.status(500).json({ message: "Error during search", error });
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
 

app.post("/api/click_to_call", async (req, res) => {
  const { destination_number, async, agent_number, caller_id } = req.body;

  console.log("Received API Request:", req.body);

  if (!destination_number || !agent_number || !caller_id) {
    return res.status(400).json({ status: "error", message: "Missing required parameters" });
  }

  try {
    const response = await axios.post(
      "https://api-smartflo.tatateleservices.com/v1/click_to_call",
      { destination_number, async, agent_number, caller_id },
      {
        headers: {
          Authorization: `Bearer ${process.env.SMARTFLO_TOKEN}`,   
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Smartflo API Response:", response.data);

    if (response.data.status === "success") {
      res.status(200).json({ status: "success", message: "Call initiated successfully" });
    } else {
      res.status(500).json({ status: "error", message: "Failed to initiate the call" });
    }
  } catch (error) {
    console.error("Error during Smartflo API call:", error.response?.data || error);
    res.status(500).json({ status: "error", message: "Error initiating the call" });
  }
});

app.get('/api/leads/transfer-requests', async (req, res) => {
  try {
    const requests = await TransferRequest.find({ status: 'pending' }).populate("leadId");
    res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching transfer requests:", error);
    res.status(500).json({ message: "Error fetching transfer requests", error: error.message });
  }
});
 
app.post('/api/leads/transfer-request', async (req, res) => {
  const { leadId, requestedBy, role } = req.body;
  if (!leadId || !requestedBy || !role) {
    return res.status(400).json({ message: "Missing required parameters" });
  }
  try {
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    } 

    if (role === "Sales Agent") {
      if (lead.agentAssigned === requestedBy) {
        return res.status(400).json({ message: "You are already assigned to this lead" });
      }
    } else if (role === "Retention Agent") {
      if (lead.healthExpertAssigned === requestedBy) {
        return res.status(400).json({ message: "You are already assigned to this lead" });
      }
    } else {
      return res.status(400).json({ message: "Invalid role for transfer" });
    } 

    const newRequest = new TransferRequest({ leadId, requestedBy, role });
    await newRequest.save();
    return res.status(200).json({ message: "Transfer request sent successfully", request: newRequest });
  } catch (error) {
    console.error("Error in transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
}); 

app.post('/api/leads/transfer-approve', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required" });
  }
  try {
    const transferRequest = await TransferRequest.findById(requestId);
    if (!transferRequest) {
      return res.status(404).json({ message: "Transfer request not found" });
    }
    if (transferRequest.status !== 'pending') {
      return res.status(400).json({ message: "Transfer request already processed" });
    }
    const lead = await Lead.findById(transferRequest.leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    } 
    if (transferRequest.role === "Sales Agent") {
      lead.agentAssigned = transferRequest.requestedBy;
    } else if (transferRequest.role === "Retention Agent") {
      lead.healthExpertAssigned = transferRequest.requestedBy;
    }
    await lead.save();
    transferRequest.status = "approved";
    await transferRequest.save();
    return res.status(200).json({ message: "Transfer request approved and lead updated", lead });
  } catch (error) {
    console.error("Error approving transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
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

app.post('/api/leads/transfer-reject', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required" });
  }
  try {
    const transferRequest = await TransferRequest.findById(requestId);
    if (!transferRequest) {
      return res.status(404).json({ message: "Transfer request not found" });
    }
    if (transferRequest.status !== 'pending') {
      return res.status(400).json({ message: "Transfer request already processed" });
    }
    transferRequest.status = "rejected";
    await transferRequest.save();
    return res.status(200).json({ message: "Transfer request rejected", transferRequest });
  } catch (error) {
    console.error("Error rejecting transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

app.get('/api/leads/transfer-requests/all', async (req, res) => {
  try {
    const requests = await TransferRequest.find().populate("leadId");
    res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching transfer requests:", error);
    res.status(500).json({ message: "Error fetching transfer requests", error: error.message });
  }
});


// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 