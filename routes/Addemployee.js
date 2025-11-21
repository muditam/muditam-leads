const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");

/**
 * GET /api/employees
 * - Without params: list employees (optionally filter by role)
 * - With fullName & email: return limited info for that unique employee (used in Navbar target/async logic)
 */
router.get("/api/employees", async (req, res) => {
  const { role, fullName, email } = req.query;

  try {
    // Special case: used by Navbar to fetch target/async etc for logged-in user
    if (fullName && email) {
      const employee = await Employee.findOne({ fullName, email });
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const {
        async,
        agentNumber,
        callerId,
        target,
        hasTeam,
        isDoctor,
      } = employee;
      return res.status(200).json([
        { async, agentNumber, callerId, target, hasTeam, isDoctor },
      ]);
    }

    const query = role ? { role } : {};

    const employees = await Employee.find(query)
      .select(
        "fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages permissions"
      )
      .populate("teamLeader", "fullName");

    const formatted = employees.map((emp) => ({
      ...emp.toObject(),
      teamLeader: emp.teamLeader
        ? {
            _id: emp.teamLeader._id,
            fullName: emp.teamLeader.fullName,
          }
        : null,
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ message: "Error fetching employees", error });
  }
});

/**
 * GET /api/employees/:id
 * - Single employee detail + teamMembers
 */
router.get("/api/employees/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id)
      .populate({
        path: "teamMembers",
        select:
          "fullName email role status target teamLeader joiningDate permissions",
        populate: {
          path: "teamLeader",
          select: "fullName",
        },
      })
      .populate("teamLeader", "fullName email role status");

    if (!emp) return res.status(404).json({ message: "Not found" });

    const data = emp.toObject();

    data.teamMembers = data.teamMembers.map((tm) => ({
      ...tm,
      teamLeader: tm.teamLeader?.fullName || "--",
    }));

    res.json(data);
  } catch (err) {
    console.error("Error fetching employee:", err);
    res.status(500).json({ message: "Error fetching employee", error: err });
  }
});

/**
 * POST /api/employees
 * - Create new employee (with optional permissions)
 */
router.post("/api/employees", async (req, res) => {
  const {
    fullName,
    email,
    callerId,
    agentNumber,
    role,
    password,
    target,
    hasTeam,
    isDoctor,
    teamLeader,
    joiningDate,
    languages,
    status,
    permissions, // NEW
  } = req.body;

  const isAgentRole = role === "Sales Agent" || role === "Retention Agent";

  if (
    !fullName ||
    !email ||
    !role ||
    !password ||
    (isAgentRole && (!callerId || !agentNumber))
  ) {
    return res.status(400).json({ message: "All required fields are not filled." });
  }

  try {
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ message: "Email already exists." });
    }

    const newEmployee = new Employee({
      fullName,
      email,
      callerId,
      agentNumber,
      role,
      password, // NOTE: currently plain text; if you add hashing later, do it here
      async: 1,
      status: status || "active",
      target: target !== undefined ? target : 0,
      hasTeam: !!hasTeam,
      isDoctor: !!isDoctor,
      teamLeader: teamLeader || null,
      joiningDate: joiningDate || null,
      languages: Array.isArray(languages) ? languages : [],
      permissions: permissions && typeof permissions === "object"
        ? permissions
        : {
            menubar: {},
            navbar: {},
          },
    });

    await newEmployee.save();
    res.status(201).json({
      message: "Employee added successfully",
      employee: newEmployee,
    });
  } catch (error) {
    console.error("Error adding employee:", error);
    res.status(500).json({ message: "Error adding employee", error });
  }
});

/**
 * PUT /api/employees/:id
 * - Update employee (general details + permissions)
 * - Used by Edit dialog and by Permission dialog (which sends only { permissions })
 */
router.put("/api/employees/:id", async (req, res) => {
  const { id } = req.params;

  const {
    callerId,
    agentNumber,
    password,
    target,
    hasTeam,
    isDoctor,
    teamLeader,
    joiningDate,
    languages,
    permissions, // NEW
    ...rest // remaining fields like fullName, email, role, status, etc.
  } = req.body;

  try {
    const updateData = {
      ...rest,
    };

    // basic fields
    if (callerId !== undefined) updateData.callerId = callerId;
    if (agentNumber !== undefined) updateData.agentNumber = agentNumber;

    if (password) updateData.password = password;
    if (target !== undefined) updateData.target = target;
    if (typeof hasTeam !== "undefined") updateData.hasTeam = hasTeam;
    if (typeof isDoctor !== "undefined") updateData.isDoctor = isDoctor;
    if (teamLeader !== undefined) updateData.teamLeader = teamLeader || null;
    if (joiningDate !== undefined) updateData.joiningDate = joiningDate || null;

    // languages sanitization
    if (Array.isArray(languages)) {
      updateData.languages = [
        ...new Set(
          languages.map((s) => String(s).trim())
        ),
      ].filter(Boolean);
    }

    // 🔐 permissions (full object from UI)
    if (permissions && typeof permissions === "object") {
      updateData.permissions = {
        menubar: permissions.menubar || {},
        navbar: permissions.navbar || {},
      };
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { async: 1, ...updateData },
      { new: true, runValidators: true }
    );

    if (!updatedEmployee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    res.status(200).json({
      message: "Employee updated successfully",
      employee: updatedEmployee,
    });
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ message: "Error updating employee", error });
  }
});

/**
 * DELETE /api/employees/:id
 */
router.delete("/api/employees/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await Employee.findByIdAndDelete(id);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const employees = await Employee.find({}, "-password");
    res.status(200).json({
      message: "Employee deleted successfully",
      employees,
    });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ message: "Error deleting employee", error });
  }
});

/**
 * PUT /api/employees/:id/team
 * - Update teamMembers of a manager
 */
router.put("/api/employees/:id/team", async (req, res) => {
  const { id } = req.params;
  const { teamMembers } = req.body;

  if (!Array.isArray(teamMembers)) {
    return res
      .status(400)
      .json({ message: "teamMembers must be an array of employee IDs" });
  }

  try {
    const updatedManager = await Employee.findByIdAndUpdate(
      id,
      { teamMembers, hasTeam: teamMembers.length > 0 },
      { new: true }
    ).populate("teamMembers", "fullName email role status target");

    if (!updatedManager)
      return res.status(404).json({ message: "Manager not found" });

    res.status(200).json({ message: "Team updated", manager: updatedManager });
  } catch (error) {
    console.error("Error updating team:", error);
    res.status(500).json({ message: "Error updating team", error });
  }
});

module.exports = router;
