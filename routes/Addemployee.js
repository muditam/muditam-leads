const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Employee = require("../models/Employee");


const SALES_DEPARTMENTS = new Set(["sales"]);


const ROLE_TO_DEPARTMENT = {
 "sales agent": "Sales",
 "retention agent": "Retention",
 manager: "Management",
 "super admin": "Management",
 finance: "Finance",
 operations: "Operations",
 "human resource": "Human Resource",
 marketing: "Marketing",
 developer: "Technology",
 "international agent": "International",
};


function normalizeEmail(email = "") {
 return String(email).trim().toLowerCase();
}


function normalizeName(name = "") {
 return String(name).trim().replace(/\s+/g, " ");
}


function normalizeDepartment(department = "", role = "") {
 const clean = String(department || "").trim().replace(/\s+/g, " ");
 if (clean) return clean;
 return ROLE_TO_DEPARTMENT[String(role || "").toLowerCase()] || "";
}


function isSalesDepartment(department = "") {
 return SALES_DEPARTMENTS.has(String(department || "").trim().toLowerCase());
}


function toPositiveNumberOrNull(value) {
 if (value === undefined || value === null || value === "") return null;
 const parsed = Number(value);
 if (Number.isNaN(parsed) || parsed < 0) return null;
 return parsed;
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


async function refreshHasTeamFor(managerIds = []) {
 const validManagerIds = managerIds
   .filter(Boolean)
   .map((id) => String(id))
   .filter((id, idx, arr) => arr.indexOf(id) === idx)
   .filter((id) => isValidObjectId(id));


 if (!validManagerIds.length) return;


 const managers = await Employee.find({ _id: { $in: validManagerIds } })
   .select("_id teamMembers")
   .lean();


 if (!managers.length) return;


 const ops = managers.map((mgr) => ({
   updateOne: {
     filter: { _id: mgr._id },
     update: { $set: { hasTeam: Array.isArray(mgr.teamMembers) && mgr.teamMembers.length > 0 } },
   },
 }));


 if (ops.length) {
   await Employee.bulkWrite(ops);
 }
}


async function syncManagerLinks({
 employeeId,
 previousLeaderId = null,
 nextLeaderId = null,
}) {
 const touchedManagers = [];


 const previousValid =
   previousLeaderId && isValidObjectId(previousLeaderId)
     ? String(previousLeaderId)
     : null;
 const nextValid =
   nextLeaderId && isValidObjectId(nextLeaderId) ? String(nextLeaderId) : null;


 if (previousValid && previousValid !== nextValid) {
   await Employee.updateOne(
     { _id: previousValid },
     { $pull: { teamMembers: employeeId } }
   );
   touchedManagers.push(previousValid);
 }


 if (nextValid) {
   await Employee.updateOne(
     { _id: nextValid },
     { $addToSet: { teamMembers: employeeId } }
   );
   touchedManagers.push(nextValid);
 }


 await refreshHasTeamFor(touchedManagers);
}


function buildHierarchyTree(employees = []) {
 const byId = new Map();
 const childrenByLeader = new Map();


 employees.forEach((emp) => {
   byId.set(String(emp._id), {
     _id: emp._id,
     fullName: emp.fullName,
     email: emp.email,
     role: emp.role,
     department: emp.department || "",
     status: emp.status,
     joiningDate: emp.joiningDate || null,
     joiningSalary: emp.joiningSalary ?? null,
     target: emp.target || 0,
     reportsTo: emp.teamLeader || null,
     reports: [],
   });
 });


 employees.forEach((emp) => {
   if (!emp.teamLeader) return;
   const parentId = String(emp.teamLeader);
   if (!childrenByLeader.has(parentId)) childrenByLeader.set(parentId, []);
   childrenByLeader.get(parentId).push(String(emp._id));
 });


 for (const [leaderId, reportIds] of childrenByLeader.entries()) {
   const parent = byId.get(leaderId);
   if (!parent) continue;
   parent.reports = reportIds
     .map((id) => byId.get(id))
     .filter(Boolean)
     .sort((a, b) => a.fullName.localeCompare(b.fullName));
 }


 const roots = [];
 byId.forEach((node) => {
   if (!node.reportsTo || !byId.has(String(node.reportsTo))) {
     roots.push(node);
   }
 });


 return roots.sort((a, b) => a.fullName.localeCompare(b.fullName));
}


router.get("/api/employees", async (req, res) => {
 const { role, fullName, email } = req.query;


 try {
   // Used by Navbar to fetch target/async etc for logged-in user
   if (fullName && email) {
     const employee = await Employee.findOne({
       fullName: normalizeName(fullName),
       email: normalizeEmail(email),
     }).select("async agentNumber callerId target hasTeam isDoctor department");


     if (!employee) {
       return res.status(404).json({ message: "Employee not found" });
     }


     const { async, agentNumber, callerId, target, hasTeam, isDoctor, department } = employee;


     return res.status(200).json([
       { async, agentNumber, callerId, target, hasTeam, isDoctor, department },
     ]);
   }


   const query = role ? { role } : {};


   const employees = await Employee.find(query)
     .select(
       "fullName email department callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate joiningSalary languages permissions"
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


router.get("/api/employees/hierarchy-tree", async (req, res) => {
 try {
   const onlyActive = String(req.query.onlyActive || "true") !== "false";
   const query = onlyActive ? { status: "active" } : {};


   const employees = await Employee.find(query)
     .select(
       "fullName email role department status target joiningDate joiningSalary teamLeader"
     )
     .sort({ fullName: 1 })
     .lean();


   return res.status(200).json({
     generatedAt: new Date().toISOString(),
     onlyActive,
     hierarchy: buildHierarchyTree(employees),
   });
 } catch (error) {
   console.error("Error fetching hierarchy tree:", error);
   return res.status(500).json({ message: "Error fetching hierarchy tree" });
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
       "fullName email department callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate joiningSalary languages permissions auditLogs"
     )
     .populate({
       path: "teamMembers",
       select:
         "fullName email role department status target teamLeader joiningDate joiningSalary permissions",
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
   department,
   callerId,
   agentNumber,
   role,
   password,
   target,
   isDoctor,
   teamLeader,
   joiningDate,
   joiningSalary,
   languages,
   status,
   permissions,
 } = req.body;


 const normalizedFullName = normalizeName(fullName);
 const normalizedEmail = normalizeEmail(email);
 const normalizedDepartment = normalizeDepartment(department, role);
 const isSalesDept = isSalesDepartment(normalizedDepartment);
 const isDoctorChecked = !!isDoctor;
 const salary = toPositiveNumberOrNull(joiningSalary);
 const effectiveTarget = isSalesDept && !isDoctorChecked
   ? Number(target)
   : 0;


 if (
   !normalizedFullName ||
   !normalizedEmail ||
   !role ||
   !password ||
   !normalizedDepartment ||
   !joiningDate ||
   salary === null
 ) {
   return res
     .status(400)
     .json({ message: "All required fields are not filled." });
 }


 if (isSalesDept && !isDoctorChecked && (!Number.isFinite(effectiveTarget) || effectiveTarget <= 0)) {
   return res
     .status(400)
     .json({ message: "Sales department employees must have a valid target." });
 }


 if (teamLeader && !isValidObjectId(teamLeader)) {
   return res.status(400).json({ message: "Invalid reporting manager." });
 }


 try {
   const existingEmployee = await Employee.findOne({ email: normalizedEmail });
   if (existingEmployee) {
     return res.status(400).json({ message: "Email already exists." });
   }


   if (teamLeader) {
     const managerExists = await Employee.exists({ _id: teamLeader });
     if (!managerExists) {
       return res.status(400).json({ message: "Reporting manager not found." });
     }
   }


   const actorName = getActorName(req);


   const newEmployee = new Employee({
     fullName: normalizedFullName,
     email: normalizedEmail,
     department: normalizedDepartment,
     callerId: isSalesDept ? callerId || "" : "",
     agentNumber: isSalesDept ? agentNumber || "" : "",
     role,
     password,
     async: 1,
     status: status || "active",
     target: effectiveTarget,
     hasTeam: false,
     isDoctor: isDoctorChecked,
     teamLeader: teamLeader || null,
     joiningDate,
     joiningSalary: salary,
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
   await syncManagerLinks({
     employeeId: newEmployee._id,
     previousLeaderId: null,
     nextLeaderId: newEmployee.teamLeader,
   });


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
   isDoctor,
   teamLeader,
   joiningDate,
   joiningSalary,
   department,
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
   const previousLeaderId = employee.teamLeader ? String(employee.teamLeader) : null;
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
   if (typeof isDoctor !== "undefined") updateData.isDoctor = isDoctor;
   if (status !== undefined) updateData.status = status;


   if (teamLeader !== undefined) {
     if (teamLeader && !isValidObjectId(teamLeader)) {
       return res.status(400).json({ message: "Invalid reporting manager." });
     }


     if (teamLeader && String(teamLeader) === String(id)) {
       return res
         .status(400)
         .json({ message: "An employee cannot report to themselves." });
     }


     if (teamLeader) {
       const managerExists = await Employee.exists({ _id: teamLeader });
       if (!managerExists) {
         return res.status(400).json({ message: "Reporting manager not found." });
       }
     }


     updateData.teamLeader = teamLeader || null;
   }


   if (joiningDate !== undefined) updateData.joiningDate = joiningDate || null;


   if (joiningSalary !== undefined) {
     const salary = toPositiveNumberOrNull(joiningSalary);
     if (salary === null) {
       return res
         .status(400)
         .json({ message: "Joining salary must be a valid non-negative number." });
     }
     updateData.joiningSalary = salary;
   }


   if (department !== undefined) {
     const normalizedDepartment = normalizeDepartment(
       department,
       updateData.role || employee.role
     );
     if (!normalizedDepartment) {
       return res.status(400).json({ message: "Department is required." });
     }
     updateData.department = normalizedDepartment;
   }


   if (target !== undefined) {
     const parsedTarget = Number(target);
     if (!Number.isFinite(parsedTarget) || parsedTarget < 0) {
       return res.status(400).json({ message: "Target must be a valid number." });
     }
     updateData.target = parsedTarget;
   }


   if (Array.isArray(languages)) {
     updateData.languages = [...new Set(languages.map((s) => String(s).trim()))].filter(Boolean);
   }


   if (permissions && typeof permissions === "object") {
     updateData.permissions = {
       menubar: permissions.menubar || {},
       navbar: permissions.navbar || {},
     };
   }


   const effectiveDepartment =
     updateData.department ||
     employee.department ||
     normalizeDepartment("", updateData.role || employee.role);
   const effectiveIsSalesDepartment = isSalesDepartment(effectiveDepartment);
   const effectiveIsDoctor =
     updateData.isDoctor !== undefined ? !!updateData.isDoctor : !!employee.isDoctor;
   const effectiveHasTeam =
     typeof employee.hasTeam === "boolean" ? employee.hasTeam : false;
   const effectiveTarget =
     updateData.target !== undefined ? updateData.target : employee.target || 0;


   if (effectiveIsSalesDepartment && !effectiveIsDoctor && !effectiveHasTeam) {
     if (!Number.isFinite(effectiveTarget) || effectiveTarget <= 0) {
       return res
         .status(400)
         .json({ message: "Sales department employees must have a valid target." });
     }
   }


   if (!effectiveIsSalesDepartment) {
     updateData.callerId = "";
     updateData.agentNumber = "";
   }


   if (!effectiveIsSalesDepartment || effectiveIsDoctor || effectiveHasTeam) {
     updateData.target = 0;
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


   const nextLeaderId = employee.teamLeader ? String(employee.teamLeader) : null;
   await syncManagerLinks({
     employeeId: employee._id,
     previousLeaderId,
     nextLeaderId,
   });


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


   const previousLeaderId = employee.teamLeader ? String(employee.teamLeader) : null;


   await Employee.updateMany(
     { teamLeader: employee._id },
     { $set: { teamLeader: null } }
   );
   await Employee.updateMany(
     { teamMembers: employee._id },
     { $pull: { teamMembers: employee._id } }
   );


   await employee.deleteOne();
   await refreshHasTeamFor([previousLeaderId, employee._id]);


   const employees = await Employee.find({})
     .select(
       "fullName email department callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate joiningSalary languages permissions"
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


   const uniqueMembers = [...new Set(teamMembers.map((m) => String(m).trim()))]
     .filter(Boolean)
     .filter((memberId) => isValidObjectId(memberId) && memberId !== String(id));


   const currentMembers = (manager.teamMembers || []).map((m) => String(m));
   const membersToRemove = currentMembers.filter((m) => !uniqueMembers.includes(m));
   const membersToAdd = uniqueMembers.filter((m) => !currentMembers.includes(m));


   if (typeof manager.addAuditLog === "function") {
     manager.addAuditLog("UPDATE", actorName);
   }


   manager.teamMembers = uniqueMembers;
   manager.async = 1;
   await manager.save();


   if (membersToRemove.length) {
     await Employee.updateMany(
       { _id: { $in: membersToRemove }, teamLeader: manager._id },
       { $set: { teamLeader: null } }
     );
   }


   if (membersToAdd.length) {
     const toAddObjectIds = membersToAdd.map((m) => new mongoose.Types.ObjectId(m));
     await Employee.updateMany(
       { _id: { $in: toAddObjectIds } },
       { $set: { teamLeader: manager._id } }
     );
   }


   await refreshHasTeamFor([manager._id]);


   const populated = await Employee.findById(id)
     .select(
       "fullName email department callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate joiningSalary languages permissions"
     )
     .populate("teamMembers", "fullName email role department status target");


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



