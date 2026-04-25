const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");

router.get("/", async (req, res) => {
 try {
   const { role, department, fullName } = req.query;
   const normalizedDepartment = String(department || "").trim().toLowerCase();
   const normalizedRole = String(role || "").trim().toLowerCase();

   let roleFilter = { $in: ["Sales Agent", "Retention Agent"] };
   if (normalizedRole === "sales agent" || normalizedRole === "retention agent") {
     roleFilter = normalizedRole === "sales agent" ? "Sales Agent" : "Retention Agent";
   } else if (normalizedDepartment === "sales" || normalizedDepartment === "retention") {
     // Optional department fallback for new clients.
     roleFilter = normalizedDepartment === "sales" ? "Sales Agent" : "Retention Agent";
   }


   const all = await Employee.find({
     status: "active",
     role: roleFilter,
   });


   if (normalizedRole === "sales agent" || normalizedRole === "retention agent") {
     const userName = (fullName || "").toLowerCase().trim();
     const filtered = all.filter(
       (emp) => (emp.fullName || "").toLowerCase().trim() === userName
     );
     return res.json(filtered);
   }


   // Manager or others
   res.json(all);
 } catch (err) {
   console.error("Fetch error:", err);
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



