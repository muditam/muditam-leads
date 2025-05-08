const express = require("express");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");  // Used for "Assigned To" dropdown if needed
const router = express.Router();

// Create a new customer with duplicate phone check
router.post("/api/customers", async (req, res) => {
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate, leadSource, leadDate } = req.body;
  
  if (!name || !phone || !age || !location || !lookingFor || !assignedTo || !followUpDate || !leadSource || !leadDate ) {
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
    // 1. Parse incoming query params
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit   = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const filters = JSON.parse(req.query.filters || "{}");
    const status  = req.query.status || "";              
    const tags    = JSON.parse(req.query.tags || "[]");     
    const sortBy  = req.query.sortBy || "";                
    const assignedTo = req.query.assignedTo;          
    const createdAt = req.query.createdAt;      

    // 2. Build root-level match (only fields on Customer)
    const rootMatch = {};

    if (filters.search) {
           const regex = new RegExp(filters.search, "i");
           rootMatch.$or = [
             { name:  { $regex: regex } },
             { phone: { $regex: regex } },
           ];
         } else {
    if (filters.name)     rootMatch.name     = { $regex: filters.name,     $options: "i" };
    if (filters.phone)    rootMatch.phone    = filters.phone;
    if (filters.location) rootMatch.location = { $regex: filters.location, $options: "i" };
    if (assignedTo) {
      const assignedArray = assignedTo.split(',').map((a) => a.trim());
      rootMatch.assignedTo = assignedArray.length === 1 ? assignedArray[0] : { $in: assignedArray };
    }
   
    if (createdAt) {
      const dateStart = new Date(createdAt);
      dateStart.setHours(0, 0, 0, 0);
      const dateEnd = new Date(createdAt);
      dateEnd.setHours(23, 59, 59, 999);
      rootMatch.createdAt = { $gte: dateStart, $lte: dateEnd };
    }
  }

    // 3. Build post-lookup match for status & tags
    const postMatch = {};

    // 3a. Status filters on presales.leadStatus
    if (status === "Open") {
      postMatch["presales.leadStatus"] = {
        $in: [
          "New Lead",
          "CONS Scheduled",
          "CONS Done",
          "Call Back Later",
          "On Follow Up",
          "CNP",
          "Switch Off"
        ]
      };
    } else if (status === "Won") {
      postMatch["presales.leadStatus"] = "Sales Done";
    } else if (status === "Lost") {
      postMatch["presales.leadStatus"] = {
        $in: [
          "General Query",
          "Fake Lead",
          "Invalid Number",
          "Not Interested",
          "Ordered from Other Sources",
          "Budget issue"
        ]
      };
    }

    // 3b. Tag filters on followUpDate and Sales Done
    const orClauses = [];
    const today    = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);

    if (tags.includes("Missed")) {
      orClauses.push({ followUpDate: { $lt: today } });
    }
    if (tags.includes("Today")) {
      orClauses.push({ followUpDate: { $gte: today, $lt: tomorrow } });
    }
    if (tags.includes("Tomorrow")) {
      const afterTomorrow = new Date(tomorrow);
      afterTomorrow.setDate(afterTomorrow.getDate()+1);
      orClauses.push({ followUpDate: { $gte: tomorrow, $lt: afterTomorrow } });
    }
    if (tags.includes("Later")) {
      orClauses.push({ followUpDate: { $gt: tomorrow } });
    }
    if (tags.includes("CONS Scheduled")) {
      orClauses.push({ "presales.leadStatus": "CONS Scheduled" });
    }
    if (tags.includes("CONS Done")) {
      orClauses.push({ "presales.leadStatus": "CONS Done" });
    }
    if (tags.includes("Sales Done")) {
      orClauses.push({ "presales.leadStatus": "Sales Done" });
    }
    if (orClauses.length) {
      postMatch.$or = orClauses;
    }

    // 4. Decide sort stage
    let sortStage = { createdAt: -1 }; // default newest first
    if (sortBy === "asc")   sortStage = { name: 1 };
    if (sortBy === "desc")  sortStage = { name: -1 };
    if (sortBy === "oldest")sortStage = { createdAt: 1 };

    // 5. Build aggregation pipelines
    const pipeline = [
      { $match: rootMatch },
      {
        $lookup: {
          from: "consultationdetails",
          localField: "_id",
          foreignField: "customerId",
          as: "consultation"
        }
      },
      {
        $addFields: {
          presales: { $arrayElemAt: ["$consultation.presales", 0] },
          closing:  { $arrayElemAt: ["$consultation.closing", 0] }
        }
      },
      { $match: postMatch },
      { $sort: sortStage },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ];

    const countPipeline = [
      { $match: rootMatch },
      {
        $lookup: {
          from: "consultationdetails",
          localField: "_id",
          foreignField: "customerId",
          as: "consultation"
        }
      },
      {
        $addFields: {
          presales: { $arrayElemAt: ["$consultation.presales", 0] }
        }
      },
      { $match: postMatch },
      { $count: "total" }
    ];

    // 6. Execute both
    const [customers, countResult] = await Promise.all([
      Customer.aggregate(pipeline),
      Customer.aggregate(countPipeline)
    ]);

    const total = (countResult[0] && countResult[0].total) || 0;

    // 7. Reply
    res.json({
      customers,
      totalCustomers: total,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
 
  } catch (err) {
    console.error("Error fetching customers:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Fetch a single customer by ID
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

// Update customer details
router.put("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate, leadSource } = req.body;

  try {
    const updatedCustomer = await Customer.findByIdAndUpdate(
      id,
      { name, phone, age, location, lookingFor, assignedTo, followUpDate, leadSource },
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