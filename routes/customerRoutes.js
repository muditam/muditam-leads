const express = require("express");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");  // To get assigned employees for "Assigned To" dropdown
const router = express.Router();

// Create a new customer
router.post("/api/customers", async (req, res) => {
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate } = req.body;
  
  if (!name || !phone || !age || !location || !lookingFor || !assignedTo || !followUpDate) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    const newCustomer = new Customer({
      name,
      phone,
      age,
      location,
      lookingFor,
      assignedTo,
      followUpDate,
    });

    await newCustomer.save();
    res.status(201).json({ message: "Customer added successfully", customer: newCustomer });
  } catch (error) {
    console.error("Error adding customer:", error);
    res.status(500).json({ message: "Error adding customer", error });
  }
});

// Fetch all customers or filter by some criteria
router.get("/api/customers", async (req, res) => {
  const { page = 1, limit = 30, filters = '{}', assignedTo } = req.query;
  const filterCriteria = JSON.parse(filters);

  const query = {};

  // Apply filtering based on query params
  if (filterCriteria.name) query.name = { $regex: filterCriteria.name, $options: 'i' };
  if (filterCriteria.phone) query.phone = filterCriteria.phone;
  if (filterCriteria.location) query.location = { $regex: filterCriteria.location, $options: 'i' };
  if (assignedTo) query.assignedTo = assignedTo;

  try {
    const totalCustomers = await Customer.countDocuments(query);
    const customers = await Customer.find(query)
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.status(200).json({
      customers,
      totalCustomers,
      totalPages: Math.ceil(totalCustomers / limit),
      currentPage: Number(page),
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ message: 'Error fetching customers', error });
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
  const { name, phone, age, location, lookingFor, assignedTo, followUpDate } = req.body;

  try {
    const updatedCustomer = await Customer.findByIdAndUpdate(id, {
      name,
      phone,
      age,
      location,
      lookingFor,
      assignedTo,
      followUpDate,
    }, { new: true });

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
