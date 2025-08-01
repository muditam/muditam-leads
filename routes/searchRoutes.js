// routes/searchRoutes.js
const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Customer = require('../models/Customer');
const ConsultationDetails = require('../models/ConsultationDetails');
const Escalation = require('../models/escalation.model');

router.get('/', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ message: "Query is required" });
  }

  try {
    const leadResults = await Lead.find({
      $or: [
        { name: { $regex: query, $options: "i" } },
        { contactNumber: { $regex: query } }
      ],
    }).limit(10).lean();

    const contactNumbers = leadResults.map(l => l.contactNumber);
    const escalations = await Escalation.find({
      contactNumber: { $in: contactNumbers },
      status: { $in: ["Open", "In Progress"] }
    }).lean();

    const escalationMap = new Set(escalations.map(e => e.contactNumber));

    const formattedLeads = leadResults.map(item => ({
      _id: item._id,
      name: item.name,
      contactNumber: item.contactNumber,
      agentAssigned: item.agentAssigned || "",
      healthExpertAssigned: item.healthExpertAssigned || "",
      source: "lead",
      hasOpenEscalation: escalationMap.has(item.contactNumber)
    }));

    const customerResults = await Customer.find({
      $or: [
        { name: { $regex: query, $options: "i" } },
        { phone: { $regex: query } }
      ],
    }).limit(10).lean();

    const customerIds = customerResults.map(c => c._id);
    const consultationMap = {};

    const consultations = await ConsultationDetails.find({
      customerId: { $in: customerIds }
    })
      .populate("presales.assignExpert", "fullName")
      .lean();

    consultations.forEach(c => {
      consultationMap[c.customerId.toString()] = c.presales.assignExpert?.fullName || "";
    });

    const formattedCustomers = customerResults.map(item => ({
      _id: item._id,
      name: item.name,
      contactNumber: item.phone,
      agentAssigned: item.assignedTo || "",
      healthExpertAssigned: consultationMap[item._id.toString()] || "",
      source: "customer"
    }));

    const combined = [...formattedLeads, ...formattedCustomers].slice(0, 10);

    res.status(200).json(combined);
  } catch (error) {
    console.error("Error during search:", error);
    res.status(500).json({ message: "Error during search", error });
  }
});

module.exports = router;
