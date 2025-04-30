const express = require("express");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");  // Used for "Assigned To" dropdown if needed
const router = express.Router();

// Create a new customer with duplicate phone check
router.post("/api/customers", async (req, res) => {
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate, leadSource } = req.body;
  
  if (!name || !phone || !age || !location || !lookingFor || !assignedTo || !followUpDate || !leadSource) {
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
    });

    await newCustomer.save();
    res.status(201).json({ message: "Customer added successfully", customer: newCustomer });
  } catch (error) {
    console.error("Error adding customer:", error);
    res.status(500).json({ message: "Error adding customer", error });
  }
});

// Get customers with pagination and optional filters
router.get("/api/customers", async (req, res) => {
  // Parse pagination parameters and filters
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 30;
  const filters = req.query.filters || '{}';
  const filterCriteria = JSON.parse(filters);
  const assignedTo = req.query.assignedTo;

  const query = {};
  if (filterCriteria.name) {
    query.name = { $regex: filterCriteria.name, $options: "i" };
  }
  if (filterCriteria.phone) {
    query.phone = filterCriteria.phone;
  }
  if (filterCriteria.location) {
    query.location = { $regex: filterCriteria.location, $options: "i" };
  }
  if (assignedTo) {
    query.assignedTo = assignedTo;
  }

  try {
    const totalCustomers = await Customer.countDocuments(query);

    const customers = await Customer.aggregate([
      { $match: query },
      { $sort: { createdAt: -1 } },  
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $lookup: {
          from: "consultationdetails", // Ensure this collection name is correct
          localField: "_id",
          foreignField: "customerId",
          as: "consultation",
        },
      },
      {
        $addFields: {
          presales: { $arrayElemAt: ["$consultation.presales", 0] },
          closing: { $arrayElemAt: ["$consultation.closing", 0] },
        },
      },
    ]);

    res.status(200).json({
      customers,
      totalCustomers,
      totalPages: Math.ceil(totalCustomers / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ message: "Error fetching customers", error });
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
