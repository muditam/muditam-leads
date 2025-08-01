// routes/leadTransferRoutes.js
const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const TransferRequest = require('../models/TransferRequests');

// GET: Pending transfer requests
router.get('/transfer-requests', async (req, res) => {
  try {
    const requests = await TransferRequest.find({ status: 'pending' }).populate("leadId");
    res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching transfer requests:", error);
    res.status(500).json({ message: "Error fetching transfer requests", error: error.message }); 
  }
});

// GET: All transfer requests
router.get('/transfer-requests/all', async (req, res) => {
  try {
    const requests = await TransferRequest.find().populate("leadId");
    res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching transfer requests:", error);
    res.status(500).json({ message: "Error fetching transfer requests", error: error.message });
  }
});

// POST: Request transfer
router.post('/transfer-request', async (req, res) => {
  const { leadId, requestedBy, role } = req.body;
  if (!leadId || !requestedBy || !role) {
    return res.status(400).json({ message: "Missing required parameters" });
  }
  try {
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    } 

    if (role === "Sales Agent" && lead.agentAssigned === requestedBy) {
      return res.status(400).json({ message: "You are already assigned to this lead" });
    } else if (role === "Retention Agent" && lead.healthExpertAssigned === requestedBy) {
      return res.status(400).json({ message: "You are already assigned to this lead" });
    } else if (!["Sales Agent", "Retention Agent"].includes(role)) {
      return res.status(400).json({ message: "Invalid role for transfer" });
    }

    const newRequest = new TransferRequest({ leadId, requestedBy, role });
    await newRequest.save();
    return res.status(200).json({ message: "Transfer request sent successfully", request: newRequest });
  } catch (error) {
    console.error("Error in transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

// POST: Approve transfer
router.post('/transfer-approve', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required" });
  }
  try {
    const transferRequest = await TransferRequest.findById(requestId);
    if (!transferRequest) {
      return res.status(404).json({ message: "Transfer request not found" });
    }
    if (transferRequest.status !== 'pending') {
      return res.status(400).json({ message: "Transfer request already processed" });
    }
    const lead = await Lead.findById(transferRequest.leadId);
    if (!lead) {
      return res.status(404).json({ message: "Lead not found" });
    } 
    if (transferRequest.role === "Sales Agent") {
      lead.agentAssigned = transferRequest.requestedBy;
    } else if (transferRequest.role === "Retention Agent") {
      lead.healthExpertAssigned = transferRequest.requestedBy;
    }
    await lead.save();
    transferRequest.status = "approved";
    await transferRequest.save();
    return res.status(200).json({ message: "Transfer request approved and lead updated", lead });
  } catch (error) {
    console.error("Error approving transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

// POST: Reject transfer
router.post('/transfer-reject', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ message: "Request ID is required" });
  }
  try {
    const transferRequest = await TransferRequest.findById(requestId);
    if (!transferRequest) { 
      return res.status(404).json({ message: "Transfer request not found" });
    }
    if (transferRequest.status !== 'pending') {
      return res.status(400).json({ message: "Transfer request already processed" });
    }
    transferRequest.status = "rejected";
    await transferRequest.save();
    return res.status(200).json({ message: "Transfer request rejected", transferRequest });
  } catch (error) {
    console.error("Error rejecting transfer request:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

module.exports = router;
