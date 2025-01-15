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

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
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
  contactNumber: { type: String, required: true },
  role: { type: String, required: true },
  password: { type: String, required: true },
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
      channel_name: order.source_name || 'Unknown' // Adjust this field based on actual API response
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
  const shopifyAPIEndpoint = `https://${process.env.SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2024-04/orders.json?status=any&created_at_min=2025-01-01T00:00:00Z&limit=250`;
  try {
    const orders = await fetchAllOrders(shopifyAPIEndpoint, process.env.SHOPIFY_API_SECRET);
    res.json(orders); // Ensure this includes the channel_name in each order object
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

// Configure multer for file uploads
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

    // Insert validated leads into the database
    await Lead.insertMany(leads.filter(Boolean));
    res.json({ success: true });
  } catch (err) {
    console.error("Error processing file:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Routes for employees
app.get("/api/employees", async (req, res) => {
  const { role } = req.query;

  try {
    let employees;
    if (role) {
      employees = await Employee.find({ role }, "fullName email contactNumber role");
    } else {
      employees = await Employee.find({}, "fullName email contactNumber role");
    }

    res.status(200).json(employees);
  } catch (error) {
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
    const employees = await Employee.find({}, '-password'); // Fetch updated employees list
    res.status(200).json({ message: 'Employee deleted successfully', employees });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting employee', error });
  }
});

app.put('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const { password, ...updateData } = req.body; // Extract password from request body

  try {
    // If a password is provided, include it in the update
    if (password) {
      updateData.password = password;
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updatedEmployee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.status(200).json({ message: 'Employee updated successfully', employee: updatedEmployee });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ message: 'Error updating employee', error });
  }
});

app.post('/api/employees', async (req, res) => {
  const { fullName, email, contactNumber, role, password } = req.body;

  // Check for missing fields
  if (!fullName || !email || !contactNumber || !role || !password) {
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
      contactNumber,
      role,
      password,
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

app.put('/api/leads/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const updatedLead = await Lead.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true, // Ensures validation rules are applied
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

app.get('/api/leads', async (req, res) => {
  const { agentAssignedName, salesStatus } = req.query;
  try {
    let query = {};
    if (agentAssignedName) query.agentAssigned = agentAssignedName;
    if (salesStatus) query.salesStatus = salesStatus;
    const leads = await Lead.find(query);

    res.status(200).json(leads);
  } catch (error) {
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

// Route for Master Data - Retention
app.get('/api/leads/retention', async (req, res) => {
  try {
    const leads = await Lead.find(
      { salesStatus: "Sales Done" },
      {
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
      }
    );
    res.status(200).json(leads);
  } catch (error) {
    res.status(500).json({
      message: 'Error fetching retention data',
      error: error.message,
    });
  }
});

app.get('/api/leads/retentions', async (req, res) => {
  const { fullName, email } = req.query; // Get from frontend

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
        date: 1,
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

    // Match passwords directly (no hashing)
    if (user.password !== password) {
      return res.status(400).json({ message: "Invalid email or password." });
    }

    // Send user data back (excluding sensitive info like password)
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


// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});