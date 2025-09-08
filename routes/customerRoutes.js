const express = require("express");
const mongoose = require('mongoose');
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");   
const ConsultationDetails = require("../models/ConsultationDetails");
const router = express.Router();
const { Transform: Json2CsvTransform } = require('json2csv');
const { pipeline } = require('stream');
const { Transform: StreamTransform } = require('stream');


// Create a new customer with duplicate phone check
router.post("/api/customers", async (req, res) => {
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate, leadSource, leadDate } = req.body;
  
  if (!name || !phone || !age || !lookingFor || !assignedTo || !followUpDate || !leadSource || !leadDate ) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    // Check if a customer with the same phone already exists
    const existingCustomer = await Customer.findOne({ phone });
    if (existingCustomer) {
      return res.status(400).json({ message: "Phone number already exists." });
    }

    const newCustomer = new Customer({
      name,  
      phone, 
      age,
      location,
      lookingFor,
      assignedTo,
      followUpDate, 
      leadSource,
      leadDate,
    });

    await newCustomer.save();
    res.status(201).json({ message: "Customer added successfully", customer: newCustomer });
  } catch (error) {
    console.error("Error adding customer:", error);
    res.status(500).json({ message: "Error adding customer", error });
  }
});


router.get("/api/customers", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const skip = req.query.skip !== undefined ? parseInt(req.query.skip, 10) : null;

    const filters = JSON.parse(req.query.filters || "{}");
    const status = req.query.status || "";
    const tags = JSON.parse(req.query.tags || "[]");
    const sortBy = req.query.sortBy || "";
    const assignedTo = req.query.assignedTo;
    const createdAt = req.query.createdAt;
    const userRole = req.query.userRole;
    const userName = req.query.userName;

    const rootMatch = {};

    // Search & Filter conditions
    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      rootMatch.$or = [
        { name: { $regex: regex } },
        { phone: { $regex: regex } },
        { location: { $regex: regex } },
      ];
    }
    if (filters.name) rootMatch.name = { $regex: filters.name, $options: "i" };
    if (filters.phone) rootMatch.phone = filters.phone;
    if (filters.location) rootMatch.location = { $regex: filters.location, $options: "i" };

    // Assigned To filter (from dropdown or role)
    if (assignedTo) {
      const assignedArray = assignedTo.split(",").map((a) => a.trim());
      rootMatch.assignedTo =
        assignedArray.length === 1 ? assignedArray[0] : { $in: assignedArray };
    }

    // Role-based filtering
    if (userRole === "Sales Agent" && userName) {
      rootMatch.assignedTo = userName;
    }
    if (userRole === "Retention Agent" && userName) { 
      rootMatch.assignedTo = userName;
    }

    // Created At filter
    if (createdAt) {
      const dateStart = new Date(createdAt);
      dateStart.setHours(0, 0, 0, 0);
      const dateEnd = new Date(createdAt);
      dateEnd.setHours(23, 59, 59, 999);
      rootMatch.createdAt = { $gte: dateStart, $lte: dateEnd };
    }

    // Open / Won / Lost status filter
    const openStatuses = [
      "New Lead",
      "CONS Scheduled",
      "CONS Done",
      "Call Back Later",
      "On Follow Up",
      "CNP",
      "Switch Off",
    ];
    const lostStatuses = [
      "General Query",
      "Fake Lead",
      "Invalid Number",
      "Not Interested-Lost",
      "Ordered from Other Sources", 
      "Budget issue",
    ];
    const wonStatuses = ["Sales Done"];

    if (status === "Open") {
      rootMatch.leadStatus = { $in: openStatuses };
    } else if (status === "Won") {
      rootMatch.leadStatus = { $in: wonStatuses };
    } else if (status === "Lost") {
      rootMatch.leadStatus = { $in: lostStatuses };
    }

    // Tag-based filters
    const orClauses = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const afterTomorrow = new Date(tomorrow);
    afterTomorrow.setDate(afterTomorrow.getDate() + 1);

    const deadStatuses = [...lostStatuses, "Switch Off"];
    // Exclude Sales Done from Missed ONLY for Sales Agent
    const excludeStatusesForMissed =
      userRole === "Sales Agent" ? [...deadStatuses, "Sales Done"] : deadStatuses;

    if (tags.includes("Missed")) {
      orClauses.push({
        $and: [
          { followUpDate: { $lt: today } },
          { leadStatus: { $nin: excludeStatusesForMissed } },
        ],
      });
    }
    if (tags.includes("Today")) {
      orClauses.push({ followUpDate: { $gte: today, $lt: tomorrow } });
    }
    if (tags.includes("Tomorrow")) {
      orClauses.push({ followUpDate: { $gte: tomorrow, $lt: afterTomorrow } });
    }
    if (tags.includes("CONS Scheduled")) {
      orClauses.push({ leadStatus: "CONS Scheduled" });
    }
    if (tags.includes("CONS Done")) {
      orClauses.push({ leadStatus: "CONS Done" });
    }
    if (tags.includes("Sales Done")) {
      orClauses.push({ leadStatus: "Sales Done" });
    }
    if (tags.includes("CNP")) {
      orClauses.push({ leadStatus: "CNP" });
    }
    if (tags.includes("On Follow Up")) {
      orClauses.push({ leadStatus: "On Follow Up" });
    }
    if (tags.includes("New Lead")) {
      orClauses.push({ leadStatus: "New Lead" });
    }
    if (tags.includes("Call Back Later")) {
      orClauses.push({ leadStatus: "Call Back Later" });
    }

    // Safely merge tag ORs with existing search ORs (if any)
    if (orClauses.length) {
      if (rootMatch.$or) {
        // already have a search $or -> keep it AND add tag $or
        rootMatch.$and = [...(rootMatch.$and || []), { $or: orClauses }];
      } else {
        rootMatch.$or = orClauses;
      }
    }

    // Sorting
    let sortStage = { createdAt: -1 };
    if (sortBy === "asc") sortStage = { name: 1 };
    if (sortBy === "desc") sortStage = { name: -1 };
    if (sortBy === "oldest") sortStage = { createdAt: 1 };

    const [customers, total] = await Promise.all([
      Customer.find(rootMatch)
        .sort(sortStage)
        .skip(skip !== null && !isNaN(skip) ? skip : (page - 1) * limit)
        .limit(limit),
      Customer.countDocuments(rootMatch),
    ]);

    res.json({
      customers,
      totalCustomers: total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
    });
  } catch (err) {
    console.error("Error fetching customers:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});



router.get("/api/customers/counts", async (req, res) => {
  try {
    const { role, userName } = req.query;

    const matchStage = {};
    if ((role === "Sales Agent" || role === "Retention Agent") && userName) {
      matchStage.assignedTo = userName;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const afterTomorrow = new Date(tomorrow);
    afterTomorrow.setDate(afterTomorrow.getDate() + 1);

    const deadStatuses = [
      "General Query",
      "Fake Lead",
      "Invalid Number",
      "Not Interested-Lost",
      "Ordered from Other Sources",
      "Budget issue",
      "Switch Off",
    ];

    const excludeStatusesForMissed =
      role === "Sales Agent" ? [...deadStatuses, "Sales Done"] : deadStatuses;

    const [openCount, wonCount, lostCount, todayCount, missedCount, tomorrowCount, newLeadCount] =
      await Promise.all([
        Customer.countDocuments({
          ...matchStage,
          leadStatus: {
            $in: [
              "New Lead",
              "CONS Scheduled",
              "CONS Done",
              "Call Back Later",
              "On Follow Up",
              "CNP",
              "Switch Off",
            ],
          },
        }),
        Customer.countDocuments({ ...matchStage, leadStatus: "Sales Done" }),
        Customer.countDocuments({
          ...matchStage,
          leadStatus: {
            $in: [
              "General Query",
              "Fake Lead",
              "Invalid Number",
              "Not Interested-Lost",
              "Ordered from Other Sources",
              "Budget issue",
            ],
          },
        }),
        // Today
        Customer.countDocuments({
          ...matchStage,
          followUpDate: { $gte: today, $lt: tomorrow },
        }),
        // Missed — 👇 use dynamic exclusion list
        Customer.countDocuments({
          ...matchStage,
          followUpDate: { $lt: today },
          leadStatus: { $nin: excludeStatusesForMissed },
        }),
        // Tomorrow
        Customer.countDocuments({
          ...matchStage,
          followUpDate: { $gte: tomorrow, $lt: afterTomorrow },
        }),
        // New Lead
        Customer.countDocuments({ ...matchStage, leadStatus: "New Lead" }),
      ]);

    res.json({
      openCount,
      wonCount,
      lostCount,
      todayCount,
      missedCount,
      tomorrowCount,
      newLeadCount,
    });
  } catch (err) {
    console.error("Error fetching counts:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get('/api/customers/export-csv', async (req, res) => {
  try {
    const {
      filters = '{}',
      status = '',
      tags = '[]',
      assignedTo = '',
      createdAt = '',
      userRole = '',
      userName = '',
      sortBy = 'newest',
    } = req.query;

    const filtersObj = JSON.parse(filters);
    const tagsArray = JSON.parse(tags);

    const match = {};

    // ---- same matching logic you already have (search, role, createdAt, status, tags) ----
    if (filtersObj.search) {
      const regex = new RegExp(filtersObj.search, 'i');
      match.$or = [{ name: regex }, { phone: regex }, { location: regex }];
    }
    if (filtersObj.name) match.name = { $regex: filtersObj.name, $options: 'i' };
    if (filtersObj.phone) match.phone = filtersObj.phone;
    if (filtersObj.location) match.location = { $regex: filtersObj.location, $options: 'i' };

    if (assignedTo) {
      const arr = assignedTo.split(',').map(s => s.trim());
      match.assignedTo = arr.length === 1 ? arr[0] : { $in: arr };
    }

    if ((userRole === 'Sales Agent' || userRole === 'Retention Agent') && userName) {
      match.assignedTo = userName;
    }

    if (createdAt) {
      const start = new Date(createdAt); start.setHours(0,0,0,0);
      const end   = new Date(createdAt); end.setHours(23,59,59,999);
      match.createdAt = { $gte: start, $lte: end };
    }

    const openStatuses = [
      'New Lead','CONS Scheduled','CONS Done','Call Back Later','On Follow Up','CNP','Switch Off',
    ];
    const lostStatuses = [
      'General Query','Fake Lead','Invalid Number','Not Interested-Lost','Ordered from Other Sources','Budget issue',
    ];
    const wonStatuses = ['Sales Done'];

    if (status === 'Open')  match.leadStatus = { $in: openStatuses };
    if (status === 'Won')   match.leadStatus = { $in: wonStatuses };
    if (status === 'Lost')  match.leadStatus = { $in: lostStatuses };

    if (Array.isArray(tagsArray) && tagsArray.length > 0) {
      const orClauses = [];
      const today = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const afterTomorrow = new Date(tomorrow); afterTomorrow.setDate(afterTomorrow.getDate() + 1);

      const deadStatuses = [...lostStatuses, 'Switch Off'];
      const excludeStatusesForMissed = (userRole === 'Sales Agent')
        ? [...deadStatuses, 'Sales Done']
        : deadStatuses;

      if (tagsArray.includes('Missed')) {
        orClauses.push({
          $and: [{ followUpDate: { $lt: today } }, { leadStatus: { $nin: excludeStatusesForMissed } }],
        });
      }
      if (tagsArray.includes('Today'))     orClauses.push({ followUpDate: { $gte: today, $lt: tomorrow } });
      if (tagsArray.includes('Tomorrow'))  orClauses.push({ followUpDate: { $gte: tomorrow, $lt: afterTomorrow } });
      if (tagsArray.includes('CONS Scheduled')) orClauses.push({ leadStatus: 'CONS Scheduled' });
      if (tagsArray.includes('CONS Done'))      orClauses.push({ leadStatus: 'CONS Done' });
      if (tagsArray.includes('Sales Done'))     orClauses.push({ leadStatus: 'Sales Done' });
      if (tagsArray.includes('CNP'))            orClauses.push({ leadStatus: 'CNP' });
      if (tagsArray.includes('On Follow Up'))   orClauses.push({ leadStatus: 'On Follow Up' });
      if (tagsArray.includes('New Lead'))       orClauses.push({ leadStatus: 'New Lead' });
      if (tagsArray.includes('Call Back Later'))orClauses.push({ leadStatus: 'Call Back Later' });

      if (orClauses.length) {
        if (match.$or) match.$and = [...(match.$and || []), { $or: orClauses }];
        else match.$or = orClauses;
      }
    }

    let sortStage = { createdAt: -1 };
    if (sortBy === 'asc')    sortStage = { name: 1 };
    if (sortBy === 'desc')   sortStage = { name: -1 };
    if (sortBy === 'oldest') sortStage = { createdAt: 1 };

    const projection = {
      name: 1, phone: 1, age: 1, location: 1, lookingFor: 1, assignedTo: 1,
      followUpDate: 1, leadSource: 1, leadDate: 1, createdAt: 1, dateAndTime: 1,
      leadStatus: 1, subLeadStatus: 1,
    };

    // Readable in objectMode
    const cursor = Customer.find(match, projection)
      .sort(sortStage)
      .lean()
      .cursor({ batchSize: 1000 });

    const toDate = d => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const toDateTime = d => (d ? new Date(d).toISOString() : '');

    // Ensure BOTH sides are object-mode here
    const mapTransform = new StreamTransform({
      readableObjectMode: true,
      writableObjectMode: true,
      transform(doc, _enc, cb) {
        cb(null, {
          name: doc.name || '',
          phone: doc.phone || '',
          age: doc.age ?? '',
          location: doc.location || '',
          lookingFor: doc.lookingFor || '',
          assignedTo: doc.assignedTo || '',
          followUpDate: toDate(doc.followUpDate),
          leadSource: doc.leadSource || '',
          leadDate: toDate(doc.leadDate),
          createdAt: toDate(doc.createdAt),
          dateAndTime: toDateTime(doc.dateAndTime),
          leadStatus: doc.leadStatus || '',
          subLeadStatus: doc.subLeadStatus || '',
        });
      }
    });

    const fields = [
      { label: 'Name', value: 'name' },
      { label: 'Phone', value: 'phone' },
      { label: 'Age', value: 'age' },
      { label: 'Location', value: 'location' },
      { label: 'Looking For', value: 'lookingFor' },
      { label: 'Assigned To', value: 'assignedTo' },
      { label: 'Follow Up Date', value: 'followUpDate' },
      { label: 'Lead Source', value: 'leadSource' },
      { label: 'Lead Date', value: 'leadDate' },
      { label: 'Created At', value: 'createdAt' },
      { label: 'Date and Time', value: 'dateAndTime' },
      { label: 'Lead Status', value: 'leadStatus' },
      { label: 'Sub Lead Status', value: 'subLeadStatus' },
    ];

    // IMPORTANT: pass transformOpts with objectMode so it CONSUMES objects and EMITS strings
    const csvTransform = new Json2CsvTransform(
      { fields, withBOM: true },
      { objectMode: true }            // <- consumes objects
    );

    const fileName = `customers_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    pipeline(cursor, mapTransform, csvTransform, res, (err) => {
      if (err) {
        console.error('CSV stream error:', err);
        if (!res.headersSent) res.status(500).end('Internal Server Error');
      }
    });
  } catch (err) {
    console.error('CSV export setup error:', err);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
});


router.get("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json(customer);
  } catch (error) {
    console.error("Error fetching customer:", error);
    res.status(500).json({ message: "Error fetching customer", error });
  }
});

router.put("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  const {
    name, phone, age, location,
    lookingFor, assignedTo, followUpDate,
    leadSource, leadStatus, subLeadStatus,
  } = req.body;

  try {
    const updatedCustomer = await Customer.findByIdAndUpdate(
      id,
      {
        name,
        phone,
        age,
        location,
        lookingFor,
        assignedTo,
        followUpDate,
        leadSource,
        leadStatus,
        subLeadStatus,
      },
      { new: true }
    );

    if (!updatedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json({
      message: "Customer updated successfully",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(500).json({ message: "Error updating customer", error });
  }
});

// Delete a customer
router.delete("/api/customers/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const deletedCustomer = await Customer.findByIdAndDelete(id);
    if (!deletedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    console.error("Error deleting customer:", error);
    res.status(500).json({ message: "Error deleting customer", error });
  }
});

module.exports = router;