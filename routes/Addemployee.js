const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Employee = require("../models/Employee");

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function normalizeName(name = "") {
  return String(name).trim().replace(/\s+/g, " ");
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function safeEmployeeResponse(employeeDoc) {
  if (!employeeDoc) return null;
  const obj = employeeDoc.toObject ? employeeDoc.toObject() : employeeDoc;
  delete obj.password;
  return obj;
}

function getActorName(req) {
  return (
    req.headers["x-agent-name"] ||
    req.body?.changedByName ||
    req.session?.user?.fullName ||
    req.session?.user?.email ||
    "Unknown"
  );
}

router.get("/api/employees", async (req, res) => {
  const { role, fullName, email } = req.query;

  try {
    // Used by Navbar to fetch target/async etc for logged-in user
    if (fullName && email) {
      const employee = await Employee.findOne({
        fullName: normalizeName(fullName),
        email: normalizeEmail(email),
      }).select("async agentNumber callerId target hasTeam isDoctor");

      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }

      const { async, agentNumber, callerId, target, hasTeam, isDoctor } = employee;

      return res.status(200).json([
        { async, agentNumber, callerId, target, hasTeam, isDoctor },
      ]);
    }

    const query = role ? { role } : {};

    const employees = await Employee.find(query)
      .select(
        "fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages permissions"
      )
      .populate("teamLeader", "fullName")
      .sort({ fullName: 1 });

    const formatted = employees.map((emp) => ({
      ...safeEmployeeResponse(emp),
      teamLeader: emp.teamLeader
        ? {
            _id: emp.teamLeader._id,
            fullName: emp.teamLeader.fullName,
          }
        : null,
    }));

    return res.status(200).json(formatted);
  } catch (error) {
    console.error("Error fetching employees:", error);
    return res.status(500).json({ message: "Error fetching employees" });
  }
});

router.get("/api/employees/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee id" });
    }

    const emp = await Employee.findById(id)
      .select(
        "fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages permissions auditLogs"
      )
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

    if (!emp) {
      return res.status(404).json({ message: "Not found" });
    }

    const data = safeEmployeeResponse(emp);

    data.teamMembers = (data.teamMembers || []).map((tm) => ({
      ...tm,
      teamLeader: tm.teamLeader?.fullName || "--",
    }));

    return res.status(200).json(data);
  } catch (err) {
    console.error("Error fetching employee:", err);
    return res.status(500).json({ message: "Error fetching employee" });
  }
});

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
    permissions,
  } = req.body;

  const isAgentRole = role === "Sales Agent" || role === "Retention Agent";
  const normalizedFullName = normalizeName(fullName);
  const normalizedEmail = normalizeEmail(email);

  if (
    !normalizedFullName ||
    !normalizedEmail ||
    !role ||
    !password ||
    (isAgentRole && (!callerId || !agentNumber))
  ) {
    return res
      .status(400)
      .json({ message: "All required fields are not filled." });
  }

  try {
    const existingEmployee = await Employee.findOne({ email: normalizedEmail });
    if (existingEmployee) {
      return res.status(400).json({ message: "Email already exists." });
    }

    const actorName = getActorName(req);

    const newEmployee = new Employee({
      fullName: normalizedFullName,
      email: normalizedEmail,
      callerId: callerId || "",
      agentNumber: agentNumber || "",
      role,
      password,
      async: 1,
      status: status || "active",
      target: target !== undefined ? target : 0,
      hasTeam: !!hasTeam,
      isDoctor: !!isDoctor,
      teamLeader: teamLeader || null,
      joiningDate: joiningDate || null,
      languages: Array.isArray(languages)
        ? [...new Set(languages.map((s) => String(s).trim()))].filter(Boolean)
        : [],
      permissions:
        permissions && typeof permissions === "object"
          ? {
              menubar: permissions.menubar || {},
              navbar: permissions.navbar || {},
            }
          : { menubar: {}, navbar: {} },
    });

    if (typeof newEmployee.addAuditLog === "function") {
      newEmployee.addAuditLog("CREATE", actorName);
    }

    await newEmployee.save();

    return res.status(201).json({
      message: "Employee added successfully",
      employee: safeEmployeeResponse(newEmployee),
    });
  } catch (error) {
    console.error("Error adding employee:", error);
    return res.status(500).json({ message: "Error adding employee" });
  }
});

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
    permissions,
    status,
    changedByName,
    ...rest
  } = req.body;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee id" });
    }

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const actorName =
      req.headers["x-agent-name"] ||
      changedByName ||
      req.session?.user?.fullName ||
      req.session?.user?.email ||
      "Unknown";

    const oldStatus = employee.status;
    const updateData = { ...rest };

    if (updateData.fullName !== undefined) {
      updateData.fullName = normalizeName(updateData.fullName);
    }

    if (updateData.email !== undefined) {
      updateData.email = normalizeEmail(updateData.email);

      const existingEmployee = await Employee.findOne({
        email: updateData.email,
        _id: { $ne: id },
      });

      if (existingEmployee) {
        return res.status(400).json({ message: "Email already exists." });
      }
    }

    if (callerId !== undefined) updateData.callerId = callerId;
    if (agentNumber !== undefined) updateData.agentNumber = agentNumber;
    if (password) updateData.password = password;
    if (target !== undefined) updateData.target = target;
    if (typeof hasTeam !== "undefined") updateData.hasTeam = hasTeam;
    if (typeof isDoctor !== "undefined") updateData.isDoctor = isDoctor;
    if (teamLeader !== undefined) updateData.teamLeader = teamLeader || null;
    if (joiningDate !== undefined) updateData.joiningDate = joiningDate || null;
    if (status !== undefined) updateData.status = status;

    if (Array.isArray(languages)) {
      updateData.languages = [...new Set(languages.map((s) => String(s).trim()))].filter(Boolean);
    }

    if (permissions && typeof permissions === "object") {
      updateData.permissions = {
        menubar: permissions.menubar || {},
        navbar: permissions.navbar || {},
      };
    }

    let actionType = "UPDATE";
    if (status !== undefined && status !== oldStatus) {
      actionType = status === "active" ? "ACTIVATE" : "INACTIVATE";
    }

    if (typeof employee.addAuditLog === "function") {
      employee.addAuditLog(actionType, actorName);
    }

    Object.assign(employee, { async: 1, ...updateData });
    await employee.save();

    return res.status(200).json({
      message: "Employee updated successfully",
      employee: safeEmployeeResponse(employee),
    });
  } catch (error) {
    console.error("Error updating employee:", error);
    return res.status(500).json({ message: "Error updating employee" });
  }
});

router.delete("/api/employees/:id", async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee id" });
    }

    const actorName = getActorName(req);

    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    if (typeof employee.addAuditLog === "function") {
      employee.addAuditLog("INACTIVATE", actorName);
      await employee.save();
    }

    await employee.deleteOne();

    const employees = await Employee.find({})
      .select(
        "fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages permissions"
      )
      .populate("teamLeader", "fullName")
      .sort({ fullName: 1 });

    return res.status(200).json({
      message: "Employee deleted successfully",
      employees: employees.map((emp) => safeEmployeeResponse(emp)),
    });
  } catch (error) {
    console.error("Error deleting employee:", error);
    return res.status(500).json({
      message: "Error deleting employee",
    });
  }
});

router.put("/api/employees/:id/team", async (req, res) => {
  const { id } = req.params;
  const { teamMembers } = req.body;

  if (!Array.isArray(teamMembers)) {
    return res
      .status(400)
      .json({ message: "teamMembers must be an array of employee IDs" });
  }

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid manager id" });
    }

    const actorName = getActorName(req);

    const manager = await Employee.findById(id);
    if (!manager) {
      return res.status(404).json({ message: "Manager not found" });
    }

    if (typeof manager.addAuditLog === "function") {
      manager.addAuditLog("UPDATE", actorName);
    }

    manager.teamMembers = teamMembers;
    manager.hasTeam = teamMembers.length > 0;
    manager.async = 1;

    await manager.save();

    const populated = await Employee.findById(id)
      .select(
        "fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages permissions"
      )
      .populate("teamMembers", "fullName email role status target");

    return res.status(200).json({
      message: "Team updated",
      manager: safeEmployeeResponse(populated),
    });
  } catch (error) {
    console.error("Error updating team:", error);
    return res.status(500).json({ message: "Error updating team" });
  }
});

router.get("/api/employees/:id/audit-logs", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid employee id" });
    }

    const employee = await Employee.findById(id).select(
      "fullName email auditLogs"
    );

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    return res.status(200).json({
      employee: { name: employee.fullName, email: employee.email },
      auditLogs: (employee.auditLogs || []).sort(
        (a, b) => new Date(b.changedAt) - new Date(a.changedAt)
      ),
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return res.status(500).json({ message: "Error fetching audit logs" });
  }
});

module.exports = router;