const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");

// In routes/employees.js
router.get("/", async (req, res) => {
  try {
    const employees = await Employee.find();
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


// PUT: Update monthly delivered sales and total
router.put("/:id/monthly-sales", async (req, res) => {
  try {
    const { monthlyDeliveredSales } = req.body;

    const totalDeliveredSales = Object.values(monthlyDeliveredSales).reduce(
      (acc, val) => acc + Number(val || 0),
      0
    );

    const updated = await Employee.findByIdAndUpdate(
      req.params.id,
      { monthlyDeliveredSales, totalDeliveredSales },
      { new: true }
    );

    res.json(updated);
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ error: "Failed to update employee sales" });
  }
});


module.exports = router;
