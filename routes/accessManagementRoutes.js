// routes/accessManagementRoutes.js
const express = require("express");
const router = express.Router();
const ToolAccessRequest = require("../models/ToolAccessRequest");


// =================== CREATE REQUEST ===================
router.post("/requests", async (req, res) => {
  try {
    const {
      toolName,
      reason,
      requestedDate,
      requestedById,
      requestedFromId,
    } = req.body;


    if (!toolName || !requestedById || !requestedFromId || !requestedDate) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields." });
    }


    const newReq = await ToolAccessRequest.create({
      toolName,
      reason,
      requestedDate,
      requestedBy: requestedById,
      requestedFrom: requestedFromId,
    });


    res.json({ success: true, data: newReq });
  } catch (err) {
    console.error("Create request error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// =================== PENDING LIST (ADMIN) ===================
router.get("/tool-requests/pending", async (_req, res) => {
  try {
    const list = await ToolAccessRequest.find({ status: "Pending" })
      .populate("requestedBy", "fullName email")
      .populate("requestedFrom", "fullName email")
      .sort({ createdAt: -1 });


    const mapped = list.map((r) => ({
      requestId: r._id,
      requestedById: r.requestedBy?._id,
      requestedByName: r.requestedBy?.fullName || "",
      requestedToId: r.requestedFrom?._id,
      requestedToName: r.requestedFrom?.fullName || "",
      reason: r.reason || "",
      requestDate: r.requestedDate || r.createdAt,
      toolName: r.toolName || "",
    }));


    res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("Pending fetch error:", err);
    res.status(500).json({ success: false });
  }
});


// =================== HISTORY (ADMIN) ===================
router.get("/tool-requests/history", async (req, res) => {
  try {
    const filters = { status: { $in: ["Completed", "Rejected"] } };


    if (req.query.employeeId) {
      filters.requestedBy = req.query.employeeId;
    }


    if (req.query.status && req.query.status !== "All") {
      filters.status = req.query.status;
    }


    const list = await ToolAccessRequest.find(filters)
      .populate("requestedBy", "fullName email")
      .populate("requestedFrom", "fullName email")
      .populate("approvedBy", "fullName email")
      .sort({ updatedAt: -1 });


    const mapped = list.map((r) => {
      // 1st preference: jisne approve / reject kiya (approvedBy)
      // 2nd preference: requestedFrom (jisko request gayi thi)
      let approverName = "-";
      if (r.approvedBy && r.approvedBy.fullName) {
        approverName = r.approvedBy.fullName;
      } else if (r.requestedFrom && r.requestedFrom.fullName) {
        approverName = r.requestedFrom.fullName;
      }


      return {
        requestId: r._id,
        requestedByName: r.requestedBy?.fullName || "-",
        requestedToName: r.requestedFrom?.fullName || "-",
        approvedByName: approverName,
        reason: r.reason || "",
        toolName: r.toolName || "",
        status: r.status,
        approvalMethod: r.shareType || "-",     // "access" / "password"
        passwordChannel: r.shareChannel || "-", // whatsapp / email / teams / ...
        rejectionRemark: r.rejectionReason || "-",
        requestDate: r.requestedDate || r.createdAt,
        actionAt: r.sharedAt || r.updatedAt,
      };
    });


    res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("History fetch error:", err);
    res.status(500).json({ success: false });
  }
});


// =================== MY REQUESTS (EMPLOYEE) ===================
router.get("/requests/mine", async (req, res) => {
  try {
    const employeeId = req.query.employeeId;
    if (!employeeId) {
      return res
        .status(400)
        .json({ success: false, message: "employeeId is required" });
    }


    const list = await ToolAccessRequest.find({ requestedBy: employeeId })
      .populate("requestedFrom", "fullName email")
      .sort({ createdAt: -1 });


    res.json({ success: true, data: list });
  } catch (err) {
    console.error("My requests fetch error:", err);
    res.status(500).json({ success: false });
  }
});


// =================== REQUESTS RECEIVED (EMPLOYEE) ===================
router.get("/requests/received", async (req, res) => {
  try {
    const employeeId = req.query.employeeId;
    if (!employeeId) {
      return res
        .status(400)
        .json({ success: false, message: "employeeId is required" });
    }


    const list = await ToolAccessRequest.find({ requestedFrom: employeeId })
      .populate("requestedBy", "fullName email")
      .sort({ createdAt: -1 });


    res.json({ success: true, data: list });
  } catch (err) {
    console.error("Received requests fetch error:", err);
    res.status(500).json({ success: false });
  }
});


// =================== APPROVE ===================
router.patch("/tool-requests/:id/approve", async (req, res) => {
  try {
    const { adminId, approvalType, passwordChannel } = req.body;
    // adminId = jisne approve kiya (admin ya requestedTo employee)


    const updated = await ToolAccessRequest.findByIdAndUpdate(
      req.params.id,
      {
        status: "Completed",
        shareType: approvalType,       // "access" / "password"
        shareChannel: passwordChannel, // whatsapp / email / teams / ...
        approvedBy: adminId,           // yehi field later history me dikhegi
        sharedAt: new Date(),          // Action At
      },
      { new: true }
    );


    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ success: false });
  }
});


// =================== REJECT ===================
router.patch("/tool-requests/:id/reject", async (req, res) => {
  try {
    const { reason, rejectionReason, adminId } = req.body;


    const finalReason = (reason || rejectionReason || "").trim();
    if (!finalReason) {
      return res
        .status(400)
        .json({ success: false, message: "Rejection reason required" });
    }


    const updated = await ToolAccessRequest.findByIdAndUpdate(
      req.params.id,
      {
        status: "Rejected",
        rejectionReason: finalReason,
        shareType: null,
        shareChannel: null,
        approvedBy: adminId || null, // jisne reject kiya
        sharedAt: new Date(),
      },
      { new: true }
    );


    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Reject error:", err);
    res.status(500).json({ success: false });
  }
});


module.exports = router;



