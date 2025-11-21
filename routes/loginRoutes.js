// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Find user by email
    const user = await Employee.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password." });
    }

    // Plain-text password check (same as your current logic)
    if (user.password !== password) {
      return res.status(400).json({ message: "Invalid email or password." });
    }

    // Prevent login if employee is inactive
    if (user.status !== "active") {
      return res
        .status(403)
        .json({ message: "Inactive employees are not allowed to login." });
    }

    // Ensure permissions always exists (even for old users)
    const permissions = user.permissions || {
      menubar: {},
      navbar: {},
    };

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        hasTeam: user.hasTeam,
        callerId: user.callerId,
        agentNumber: user.agentNumber,
        orderConfirmActive: user.orderConfirmActive,
        permissions, // 🔐 send permissions to frontend
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res
      .status(500)
      .json({ message: "Server error. Please try again later." });
  }
});

module.exports = router;
