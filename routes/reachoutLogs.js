// routes/reachoutLogs.js
const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');

// GET /api/reachout-logs/count
router.get('/count', async (req, res) => {
  try {
    const { startDate, endDate, healthExpertAssigned } = req.query;

    let start = startDate ? new Date(startDate) : new Date(0);
    let end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const matchStage = healthExpertAssigned ? { healthExpertAssigned } : {};

    const result = await Lead.aggregate([
      { $match: matchStage },
      {
        $project: {
          contactNumber: 1,
          reachoutLogs: {
            $filter: {
              input: { $ifNull: ["$reachoutLogs", []] },
              as: "log",
              cond: {
                $and: [
                  { $gte: ["$$log.timestamp", start] },
                  { $lte: ["$$log.timestamp", end] }
                ]
              }
            }
          }
        }
      },
      { $unwind: "$reachoutLogs" },
      {
        $group: {
          _id: {
            contactNumber: "$contactNumber",
            method: "$reachoutLogs.method",
          }
        }
      },
      {
        $group: {
          _id: "$_id.method",
          count: { $sum: 1 }
        }
      }
    ]);

    const uniqueLeadsResult = await Lead.aggregate([
      { $match: matchStage },
      {
        $project: {
          contactNumber: 1,
          reachoutLogs: {
            $filter: {
              input: { $ifNull: ["$reachoutLogs", []] },
              as: "log",
              cond: {
                $and: [
                  { $gte: ["$$log.timestamp", start] },
                  { $lte: ["$$log.timestamp", end] }
                ]
              }
            }
          }
        }
      },
      { $unwind: "$reachoutLogs" },
      { $group: { _id: "$contactNumber" } },
      { $count: "totalUniqueLeads" }
    ]);

    const totalCount = uniqueLeadsResult.length > 0 ? uniqueLeadsResult[0].totalUniqueLeads : 0;

    const counts = { WhatsApp: 0, Call: 0, Both: 0 };
    result.forEach((item) => {
      if (item._id) counts[item._id] = item.count;
    });

    res.json({ totalCount, ...counts });
  } catch (err) {
    console.error("Error fetching reachout logs count:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/reachout-logs/disposition-summary
router.get('/disposition-summary', async (req, res) => {
  const { startDate, endDate, healthExpertAssigned } = req.query;

  if (!healthExpertAssigned) {
    return res.status(400).json({ error: "healthExpertAssigned is required" });
  }

  try {
    const dispositionCounts = await Lead.aggregate([
      { $match: { healthExpertAssigned } },
      { $unwind: "$reachoutLogs" },
      {
        $match: {
          "reachoutLogs.timestamp": {
            $gte: new Date(startDate),
            $lte: new Date(endDate),
          },
        },
      },
      {
        $group: {
          _id: "$reachoutLogs.status",
          count: { $sum: 1 },
        },
      },
    ]);

    const countsObject = dispositionCounts.reduce((acc, curr) => {
      acc[curr._id] = curr.count;
      return acc;
    }, {});

    res.json(countsObject);
  } catch (error) {
    console.error("Error fetching disposition summary:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/reachout-logs/disposition-count
router.get('/disposition-count', async (req, res) => {
  try {
    const { startDate: startDateRaw, endDate: endDateRaw, healthExpertAssigned } = req.query;

    const matchRoot = {};
    if (healthExpertAssigned) {
      matchRoot.healthExpertAssigned = healthExpertAssigned;
    }

    let startDate, endDate;
    if (startDateRaw && endDateRaw) {
      startDate = new Date(startDateRaw);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(endDateRaw);
      endDate.setHours(23, 59, 59, 999);
    }

    const pipeline = [
      { $match: matchRoot },
      { $unwind: "$reachoutLogs" },
    ];

    if (startDate && endDate) {
      pipeline.push({
        $match: {
          "reachoutLogs.timestamp": {
            $gte: startDate,
            $lte: endDate,
          },
        },
      });
    }

    pipeline.push({
      $group: {
        _id: "$reachoutLogs.status",
        count: { $sum: 1 },
      },
    });

    const result = await Lead.aggregate(pipeline);

    const formattedResult = result.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.json(formattedResult);
  } catch (err) {
    console.error("Error fetching disposition counts:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
