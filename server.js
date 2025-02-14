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
const TransferRequest = require('./models/TransferRequests');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

 
// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Define Employee Schema
const EmployeeSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  callerId: { type: String, required: true },
  role: { type: String, required: true },
  password: { type: String, required: true },
  agentNumber: { type: String, required: true },
  async: { type: Number, default: 1 },
});

// Create Employee model
const Employee = mongoose.model('Employee', EmployeeSchema);

const RetentionSalesSchema = new mongoose.Schema({
  date: String,
  name: String,
  contactNumber: String,
  productsOrdered: [String],
  dosageOrdered: { type: String, default: "" },
  amountPaid: Number,
  modeOfPayment: String,
  deliveryStatus: String,
  orderCreatedBy: String,
});

const RetentionSales = mongoose.model("RetentionSales", RetentionSalesSchema);

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

    const fetchedOrders = response.data.orders.map(order => ({
      ...order,
      channel_name: order.source_name || 'Unknown'  
    }));

    allOrders = allOrders.concat(fetchedOrders); 

    const nextLink = response.headers.link && response.headers.link.split(',').filter(s => s.includes('rel="next"')).map(s => s.match(/<(.*)>; rel="next"/)).find(Boolean);
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
  const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=2024-07-01T00:00:00Z&created_at_max=2024-08-31T23:59:59Z&limit=250`;
  try {
    const orders = await fetchAllOrders(shopifyAPIEndpoint, process.env.SHOPIFY_API_SECRET);
    res.json(orders);  
  } catch (error) {
    console.error('Error fetching orders from Shopify:', error);
    res.status(500).send('Failed to fetch orders');
  }
});


app.get('/api/retention-sales', async (req, res) => {
  const { orderCreatedBy } = req.query;

  if (!orderCreatedBy) {
    return res.status(400).json({ message: 'Order created by is required.' });
  }

  try {
    const retentionSales = await RetentionSales.find({ orderCreatedBy }).sort({ date: -1 });
    res.status(200).json(retentionSales);
  } catch (error) {
    console.error('Error fetching retention sales:', error);
    res.status(500).json({ message: 'Error fetching retention sales', error });
  }
});


app.post('/api/retention-sales', async (req, res) => {
  const {
    date,
    name = "",
    contactNumber = "",
    productsOrdered = [],
    dosageOrdered = "",
    amountPaid = 0, 
    modeOfPayment = "Not Specified", 
    deliveryStatus = "Pending",
    orderCreatedBy,
  } = req.body;

  if (!date || !orderCreatedBy) {
    return res.status(400).json({ message: "Date and orderCreatedBy are required." });
  }

  try {
    const newSale = new RetentionSales({
      date,
      name,
      contactNumber,
      productsOrdered,
      dosageOrdered,
      amountPaid,
      modeOfPayment,
      deliveryStatus,
      orderCreatedBy,
    });

    await newSale.save();
    res.status(201).json(newSale);
  } catch (error) {
    console.error('Error adding retention sale:', error);
    res.status(500).json({ message: 'Error adding retention sale', error });
  }
});

app.put('/api/retention-sales/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const updatedSale = await RetentionSales.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    if (!updatedSale) {
      return res.status(404).json({ message: 'Sale not found' });
    }

    res.status(200).json(updatedSale);
  } catch (error) {
    console.error('Error updating retention sale:', error);
    res.status(500).json({ message: 'Error updating retention sale', error });
  }
});


// Route to Delete Retention Sale
app.delete('/api/retention-sales/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deletedSale = await RetentionSales.findByIdAndDelete(id);

    if (!deletedSale) {
      return res.status(404).json({ message: 'Sale not found' });
    }

    res.status(200).json({ message: 'Sale deleted successfully' });
  } catch (error) {
    console.error('Error deleting retention sale:', error);
    res.status(500).json({ message: 'Error deleting retention sale', error });
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
    // Parse the uploaded file
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const requiredFields = ["Date", "Name", "Contact No"];
    const errors = [];

    // Validate and prepare data for insertion
    const leads = rows.map((row, index) => {
      const missingFields = requiredFields.filter((field) => !row[field]);
      if (missingFields.length > 0) {
        errors.push(`Row ${index + 2} is missing mandatory fields: ${missingFields.join(", ")}`);
        return null;
      }
      return {
        date: row.Date,
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
    const employees = await Employee.find(query, "fullName email callerId agentNumber async role");

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

    // Respond with the updated employee data
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

  // Check for missing fields
  if (!fullName || !email || !callerId || !agentNumber || !role || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Check if the email already exists
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    // Save the new employee
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
    return isNaN(parsedDate) ? null : parsedDate;  
};


  try {
    const query = {};

    // Filters-based queries (for LeadTable)
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
      // Remove `query.date` if empty
      if (Object.keys(query.date).length === 0) delete query.date;
  }
  

    // Order Date
    if (filterCriteria.orderDate) {
      const parsedOrderDate = parseDate(filterCriteria.orderDate);
      if (parsedOrderDate) {
        query.orderDate = parsedOrderDate;
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
  

    // Direct query parameters (for SalesMyLeads)
    if (agentAssignedName) query.agentAssigned = agentAssignedName;
    if (salesStatus) query.salesStatus = salesStatus;

    // Fetch data
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


// // Route for Master Data - Retention
// app.get('/api/leads/retention', async (req, res) => {
//   const calculateReminder = (nextFollowupDate) => { 

//     const today = new Date();
//     const followupDate = new Date(nextFollowupDate);
//     const diffInDays = Math.ceil((followupDate - today) / (1000 * 60 * 60 * 24));

//     if (diffInDays < 0) return "Follow-up Missed";
//     if (diffInDays === 0) return "Today";
//     if (diffInDays === 1) return "Tomorrow";
//     return "Later";
//   };

//   try {
//     const leads = await Lead.find(
//       { salesStatus: "Sales Done" },
//       {
//         name: 1,
//         contactNumber: 1,
//         agentAssigned: 1,
//         productPitched: 1,
//         agentsRemarks: 1,
//         productsOrdered: 1,
//         dosageOrdered: 1,
//         modeOfPayment: 1,
//         deliveryStatus: 1,
//         healthExpertAssigned: 1,
//         dosageExpiring: 1,
//         rtNextFollowupDate: 1,
//         rtFollowupReminder: 1,
//         rtFollowupStatus: 1,
//         lastOrderDate: 1,
//         repeatDosageOrdered: 1,
//         retentionStatus: 1,
//         rtRemark: 1,
//       }
//     );

//     const leadsWithReminder = leads.map((lead) => ({
//       ...lead._doc,
//       rtFollowupReminder: calculateReminder(lead.rtNextFollowupDate),
//     }));

//     res.status(200).json(leadsWithReminder);
//   } catch (error) {
//     console.error("Error in retention endpoint:", error.message);
//     res.status(500).json({ message: "Internal Server Error", error: error.message });
//   }
// });


// Server-side code (e.g. in your app.js or routes file)
app.get('/api/leads/retention', async (req, res) => {
  // Read pagination parameters from the query string
  const page = parseInt(req.query.page) || 1;         
  const limit = parseInt(req.query.limit) || 50;          
  const skip = (page - 1) * limit;
 
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
    const query = { salesStatus: "Sales Done" };
 
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
      .limit(limit);
 
    const leadsWithReminder = leads.map((lead) => ({
      ...lead._doc,
      rtFollowupReminder: calculateReminder(lead.rtNextFollowupDate),
    }));

    res.status(200).json({
      leads: leadsWithReminder,
      totalLeads,
      totalPages: Math.ceil(totalLeads / limit),
      currentPage: page,
    });
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
    const leads = await Lead.find(
      { salesStatus: "Sales Done" },
      {
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
      }
    );
    res.status(200).json(leads);
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
    }).limit(10); // Limit results for performance

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


// 2. Create a transfer request
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
    // For Sales Agents, check the "agentAssigned" field.
    // For Retention Agents, check the "healthExpertAssigned" field.
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
    // Create the transfer request
    const newRequest = new TransferRequest({ leadId, requestedBy, role });
    await newRequest.save();
    return res.status(200).json({ message: "Transfer request sent successfully", request: newRequest });
  } catch (error) {
    console.error("Error in transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

// 3. Approve a transfer request (Manager action)
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
    // Update the correct assignment field based on the role
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
 
// This route must come AFTER the more specific transfer requests routes.
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