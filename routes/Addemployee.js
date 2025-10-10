const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

router.get("/api/employees", async (req, res) => {
  const { role, fullName, email } = req.query;
  try {
    if (fullName && email) {
      const employee = await Employee.findOne({ fullName, email });
      if (!employee) {
        return res.status(404).json({ message: "Employee not found" });
      }
      const { async, agentNumber, callerId, target, hasTeam, isDoctor } = employee;
      return res.status(200).json([{ async, agentNumber, callerId, target, hasTeam, isDoctor }]);
    }

    const query = role ? { role } : {};
    const employees = await Employee.find(query)
      .select("fullName email callerId agentNumber async role status target hasTeam isDoctor teamMembers teamLeader joiningDate languages")
      .populate("teamLeader", "fullName");

    const formatted = employees.map(emp => ({
      ...emp.toObject(),
      teamLeader: emp.teamLeader ? {
        _id: emp.teamLeader._id,
        fullName: emp.teamLeader.fullName
      } : null,
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ message: "Error fetching employees", error });
  }
});

router.get("/api/employees/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id)
      .populate({
        path: "teamMembers",
        select: "fullName email role status target teamLeader joiningDate",
        populate: {
          path: "teamLeader",
          select: "fullName",
        },
      })
      .populate("teamLeader", "fullName email role status");

    if (!emp) return res.status(404).json({ message: "Not found" });

    const data = emp.toObject();

    data.teamMembers = data.teamMembers.map(tm => ({
      ...tm,
      teamLeader: tm.teamLeader?.fullName || "--",
    }));

    res.json(data);
  } catch (err) {
    console.error("Error fetching employee:", err);
    res.status(500).json({ message: "Error fetching employee", error: err });
  }
});

// CREATE new employee
router.post('/api/employees', async (req, res) => {
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
    languages
  } = req.body;

  if (!fullName || !email || !callerId || !agentNumber || !role || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    const existingEmployee = await Employee.findOne({ email });
    if (existingEmployee) {
      return res.status(400).json({ message: 'Email already exists.' });
    }

    const newEmployee = new Employee({
      fullName,
      email,
      callerId,
      agentNumber,
      role,
      password,
      async: 1,
      status: 'active',
      target: target !== undefined ? target : 0,
      hasTeam: !!hasTeam,
      isDoctor: !!isDoctor,
      teamLeader: teamLeader || null,
      joiningDate: joiningDate || null,
      languages: Array.isArray(languages) ? languages : [],
    });

    await newEmployee.save();
    res.status(201).json({ message: 'Employee added successfully', employee: newEmployee });
  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ message: 'Error adding employee', error });
  }
});

router.put('/api/employees/:id', async (req, res) => {
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
    ...updateData 
  } = req.body;

  try {
    if (password) updateData.password = password;
    if (target !== undefined) updateData.target = target;
    if (typeof hasTeam !== "undefined") updateData.hasTeam = hasTeam;
    if (typeof isDoctor !== "undefined") updateData.isDoctor = isDoctor;
    if (teamLeader !== undefined) updateData.teamLeader = teamLeader;
    if (joiningDate) updateData.joiningDate = joiningDate;

    // languages: allow optional, sanitize if provided
    if (Array.isArray(languages)) {
      updateData.languages = [...new Set(
        languages.map((s) => String(s).trim())
      )].filter(Boolean);
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      id,
      { callerId, agentNumber, async: 1, ...updateData },
      { new: true, runValidators: true }
    );

    if (!updatedEmployee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.status(200).json({
      message: 'Employee updated successfully',
      employee: updatedEmployee,
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ message: 'Error updating employee', error });
  }
});


// DELETE employee
router.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await Employee.findByIdAndDelete(id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    const employees = await Employee.find({}, '-password');
    res.status(200).json({ message: 'Employee deleted successfully', employees });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting employee', error });
  }
});

// UPDATE teamMembers of a manager 
router.put("/api/employees/:id/team", async (req, res) => {
  const { id } = req.params;
  const { teamMembers } = req.body;

  if (!Array.isArray(teamMembers)) {
    return res.status(400).json({ message: "teamMembers must be an array of employee IDs" });
  }

  try {
    const updatedManager = await Employee.findByIdAndUpdate(
      id,
      { teamMembers, hasTeam: teamMembers.length > 0 },
      { new: true }
    ).populate("teamMembers", "fullName email role status target");

    if (!updatedManager) return res.status(404).json({ message: "Manager not found" });

    res.status(200).json({ message: "Team updated", manager: updatedManager });
  } catch (error) {
    res.status(500).json({ message: "Error updating team", error });
  }
});

module.exports = router;  