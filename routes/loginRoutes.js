// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await Employee.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid email or password." });

    // Plain-text check (keep if you want; ideally bcrypt)
    if (user.password !== password) {
      return res.status(400).json({ message: "Invalid email or password." });
    }

    if (user.status !== "active") {
      return res.status(403).json({ message: "Inactive employees are not allowed to login." });
    }

    const permissions = user.permissions || { menubar: {}, navbar: {} };
 
    await regenerateSession(req);
    req.session.user = {
      id: String(user._id),
      email: user.email,          
      fullName: user.fullName,
      role: user.role,
    };
    await saveSession(req);

    return res.status(200).json({
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
        permissions,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error. Please try again later." });
  }
});

module.exports = router;
