const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");






function getChangedFields(oldData, newData) {
  const changes = {};
  const oldObj = oldData.toObject ? oldData.toObject() : oldData;
 
  for (const key in newData) {
    if (key !== 'password' && newData.hasOwnProperty(key)) {
      const oldVal = JSON.stringify(oldObj[key]);
      const newVal = JSON.stringify(newData[key]);
     
      if (oldVal !== newVal) {
        changes[key] = { old: oldObj[key], new: newData[key] };
      }
    }
  }
  return changes;
}


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




router.get("/api/employees/:id",  async (req, res) => {
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


  if (
    !fullName ||
    !email ||
    !role ||
    !password ||
    (isAgentRole && (!callerId || !agentNumber))
  ) {
    return res
      .status(400)
      .json({ message: "All required fields are not filled." });
  }


  try {
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ message: "Email already exists." });
    }


    // ✅ actor name for audit log (no middleware)
    const actorName =
      req.headers["x-agent-name"] ||
      req.body.changedByName ||
      req.session?.user?.fullName ||
      req.session?.user?.email ||
      "Unknown";


    const newEmployee = new Employee({
      fullName: String(fullName).trim(),
      email,
      callerId,
      agentNumber,
      role,
      password,
      async: 1,
      status: status || "active",
      target: target !== undefined ? target : 0,
      hasTeam: !!hasTeam,
      isDoctor: !!isDoctor,
      teamLeader: teamLeader || null,
      joiningDate: joiningDate || null,
      languages: Array.isArray(languages) ? languages : [],
      permissions:
        permissions && typeof permissions === "object"
          ? {
              menubar: permissions.menubar || {},
              navbar: permissions.navbar || {},
            }
          : { menubar: {}, navbar: {} },
    });


    // ✅ Add audit log ONCE
    newEmployee.addAuditLog("CREATE", actorName);


    await newEmployee.save();


    return res.status(201).json({
      message: "Employee added successfully",
      employee: newEmployee,
    });
  } catch (error) {
    console.error("Error adding employee:", error);
    return res.status(500).json({ message: "Error adding employee", error });
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
    changedByName, // optional
    ...rest
  } = req.body;


  try {
    const employee = await Employee.findById(id);
    if (!employee) return res.status(404).json({ message: "Employee not found" });


    // ✅ DEFINE actorName (this was missing)
    const actorName =
      req.headers["x-agent-name"] ||
      changedByName ||
      req.session?.user?.fullName ||
      req.session?.user?.email ||
      "Unknown";


    const oldStatus = employee.status;


    const updateData = { ...rest };


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
      updateData.languages = [...new Set(languages.map(s => String(s).trim()))].filter(Boolean);
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
  
    employee.addAuditLog(actionType, actorName);

    Object.assign(employee, { async: 1, ...updateData });
    await employee.save();


    return res.status(200).json({
      message: "Employee updated successfully",
      employee,
    });
  } catch (error) {
    console.error("Error updating employee:", error);
    return res.status(500).json({ message: "Error updating employee", error });
  }
});
 

router.delete("/api/employees/:id", async (req, res) => {
  const { id } = req.params;


  try {
    // ✅ actor name for audit log (no middleware)
    const actorName =
      req.headers["x-agent-name"] ||
      req.body?.changedByName ||
      req.session?.user?.fullName ||
      req.session?.user?.email ||
      "Unknown";


    // 1) Find employee first (needed for audit log)
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }


    // 2) Add audit log BEFORE deleting (only works if you keep the document)
    employee.addAuditLog("INACTIVATE", actorName);


    // 3) Save audit log
    await employee.save();


    // 4) Delete employee
    await employee.deleteOne();


    const employees = await Employee.find({}, "-password");


    return res.status(200).json({
      message: "Employee deleted successfully",
      employees,
    });
  } catch (error) {
    console.error("Error deleting employee:", error);
    return res.status(500).json({
      message: "Error deleting employee",
      error,
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
    // ✅ actor name for audit log (no middleware)
    const actorName =
      req.headers["x-agent-name"] ||
      req.body.changedByName ||
      req.session?.user?.fullName ||
      req.session?.user?.email ||
      "Unknown";


    // ✅ Load manager first so we can append auditLogs
    const manager = await Employee.findById(id);
    if (!manager) return res.status(404).json({ message: "Manager not found" });


    // ✅ Audit log for team update (counts as UPDATE)
    manager.addAuditLog("UPDATE", actorName);


    // ✅ Apply update + save
    manager.teamMembers = teamMembers;
    manager.hasTeam = teamMembers.length > 0;
    manager.async = 1;


    await manager.save();


    // Populate for response
    const populated = await Employee.findById(id).populate(
      "teamMembers",
      "fullName email role status target"
    );


    return res.status(200).json({ message: "Team updated", manager: populated });
  } catch (error) {
    console.error("Error updating team:", error);
    return res.status(500).json({ message: "Error updating team", error });
  }
});




router.get("/api/employees/:id/audit-logs", async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id).select(
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
    return res.status(500).json({ message: "Error fetching audit logs", error });
  }
});
module.exports = router;



