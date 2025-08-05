// routes/duplicateLeads.js

const express = require("express");
const router = express.Router();
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");

// Helper to normalize numbers
function normalizeNumber(num) {
  if (!num) return "";
  num = num.replace(/\D/g, ""); // Remove all non-digits
  return num.slice(-10); // Last 10 digits
}

// GET /api/duplicate-leads/duplicates
router.get("/duplicates", async (req, res) => {
  try {
    // 1. Fetch all leads with normalized numbers
    const leads = await Lead.aggregate([
      {
        $addFields: {
          normalizedNumber: {
            $let: {
              vars: {
                digits: {
                  $regexFind: {
                    input: "$contactNumber",
                    regex: /(\d{10})$/
                  }
                }
              },
              in: "$$digits.match"
            }
          }
        }
      },
      {
        $match: {
          normalizedNumber: { $exists: true, $ne: null, $ne: "" }
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          contactNumber: "$contactNumber",
          agentAssigned: 1,
          leadStatus: 1,
          salesStatus: 1,
          healthExpertAssigned: 1,
          retentionStatus: 1,
          normalizedNumber: 1,
          type: { $literal: "lead" }
        }
      }
    ]);

    // 2. Fetch all customers with normalized numbers
    const customers = await Customer.aggregate([
      {
        $addFields: {
          normalizedNumber: {
            $let: {
              vars: {
                digits: {
                  $regexFind: {
                    input: "$phone",
                    regex: /(\d{10})$/
                  }
                }
              },
              in: "$$digits.match"
            }
          }
        }
      },
      {
        $match: {
          normalizedNumber: { $exists: true, $ne: null, $ne: "" }
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          contactNumber: "$phone", // so frontend is consistent
          agentAssigned: null, // customers don't have this
          leadStatus: "$leadStatus",
          salesStatus: null,
          healthExpertAssigned: "$assignedTo", // map assignedTo
          retentionStatus: null,
          normalizedNumber: 1,
          type: { $literal: "customer" }
        }
      }
    ]);

    // 3. Combine leads & customers
    const all = leads.concat(customers);

    // 4. Group by normalizedNumber
    const groupsMap = {};
    for (const doc of all) {
      const norm = doc.normalizedNumber;
      if (!groupsMap[norm]) groupsMap[norm] = [];
      groupsMap[norm].push(doc);
    }

    // 5. Only include groups with more than 1 record (i.e. duplicates)
    const duplicateGroups = Object.entries(groupsMap)
      .filter(([_, group]) => group.length > 1)
      .map(([normalizedNumber, group]) => ({
        contactNumber: normalizedNumber,
        leads: group // contains both leads and customers
      }));

    res.json(duplicateGroups);
  } catch (err) {
    console.error("Error fetching duplicates:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT update duplicate group: Updates all leads with the normalized contact number
router.put("/update-duplicate-group", async (req, res) => {
  try {
    const { oldContactNumber, updatedData } = req.body;
    if (!oldContactNumber || !updatedData) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    const normalized = normalizeNumber(oldContactNumber);
    const updateResult = await Lead.updateMany(
      {
        $expr: {
          $eq: [
            { $substr: [{ $replaceAll: { input: "$contactNumber", find: /\D/g, replacement: "" } }, -10, 10] },
            normalized
          ]
        }
      },
      { $set: updatedData }
    );
    res.json({ message: "Duplicate group updated", updateResult });
  } catch (err) {
    console.error("Error updating duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE duplicate group: Deletes all leads with the normalized contact number

// DELETE group: Deletes all leads and customers with the normalized contact number
router.delete("/duplicate-number", async (req, res) => {
  try {
    const { contactNumber } = req.body;
    if (!contactNumber) {
      return res.status(400).json({ error: "Missing contact number" });
    }
    const normalized = normalizeNumber(contactNumber);

    // Delete from Lead
    const leadDeleteResult = await Lead.deleteMany({
      $expr: {
        $eq: [
          { $substr: [{ $replaceAll: { input: "$contactNumber", find: /\D/g, replacement: "" } }, -10, 10] },
          normalized
        ]
      }
    });

    // Delete from Customer
    const customerDeleteResult = await Customer.deleteMany({
      $expr: {
        $eq: [
          { $substr: [{ $replaceAll: { input: "$phone", find: /\D/g, replacement: "" } }, -10, 10] },
          normalized
        ]
      }
    });

    res.json({ 
      message: "Leads and Customers with duplicate group deleted",
      leadDeleteResult,
      customerDeleteResult
    });
  } catch (err) {
    console.error("Error deleting duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE row-wise: Delete a single record by its type and _id
router.delete("/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  try {
    if (type === "lead") {
      await Lead.findByIdAndDelete(id); 
      return res.json({ message: "Lead deleted" });
    } else if (type === "customer") {
      await Customer.findByIdAndDelete(id);
      return res.json({ message: "Customer deleted" });
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }
  } catch (err) {
    console.error("Error deleting:", err);
    res.status(500).json({ error: "Server error" });
  }
});


module.exports = router;
