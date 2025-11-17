// routes/globalRetentionDetails.js
const express = require("express");
const router = express.Router();
const GlobalRetentionLead = require("../InternationalModel/GlobalRetentionLead");

// GET /api/global-retention-details/get-details/:contactNumber
router.get("/get-details/:contactNumber", async (req, res) => {
  try {
    const { contactNumber } = req.params;

    if (!contactNumber) {
      return res
        .status(400)
        .json({ message: "contactNumber is required in URL" });
    }

    const trimmed = String(contactNumber).trim();

    const lead = await GlobalRetentionLead.findOne({
      $or: [{ phoneNumber: trimmed }, { contactNumber: trimmed }],
    }).lean();

    if (!lead) {
      return res.json({ details: null });
    }

    return res.json({
      details: lead.globalRetentionDetails || null,
    });
  } catch (err) {
    console.error("GET /api/global-retention-details/get-details error:", err);
    res.status(500).json({ message: "Failed to fetch retention details" });
  }
});

// POST /api/global-retention-details/save-details
// body: { contactNumber, details }
router.post("/save-details", async (req, res) => {
  try {
    const { contactNumber, details } = req.body || {};

    if (!contactNumber) {
      return res
        .status(400)
        .json({ message: "contactNumber is required in body" });
    }

    if (!details || typeof details !== "object") {
      return res
        .status(400)
        .json({ message: "details object is required in body" });
    }

    const trimmed = String(contactNumber).trim();

    const lead = await GlobalRetentionLead.findOneAndUpdate(
      { phoneNumber: trimmed },
      {
        $setOnInsert: {
          phoneNumber: trimmed,
          contactNumber: trimmed,
        },
        $set: {
          globalRetentionDetails: details,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.json({
      message: "Retention details saved.",
      details: lead.globalRetentionDetails || null,
    });
  } catch (err) {
    console.error("POST /api/global-retention-details/save-details error:", err);
    res.status(500).json({ message: "Failed to save retention details" });
  }
});

module.exports = router;
