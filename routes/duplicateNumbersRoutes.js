// routes/duplicateLeads.js

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");

// ------------------------ Helpers ------------------------

function normalizeNumber(num) {
  if (!num) return "";
  num = num.replace(/\D/g, ""); // Remove all non-digits
  return num.slice(-10); // Last 10 digits
}

function exprMatchLast10Digits(fieldPath, normalized) {
  return {
    $expr: {
      $eq: [
        {
          $substr: [
            { $replaceAll: { input: fieldPath, find: /\D/g, replacement: "" } },
            -10,
            10
          ]
        },
        normalized
      ]
    }
  };
}

const isValidObjectId = (v) => {
  try {
    return !!(v && mongoose.Types.ObjectId.isValid(v));
  } catch {
    return false;
  }
};

// ------------------------ Endpoints ------------------------

/**
 * GET /api/duplicate-leads/duplicates
 * Server-side pagination of duplicate groups
 * Query: page (1-based), limit
 * Response: { page, limit, totalGroups, groups: [{ contactNumber, leads: [...] }] }
 */
router.get("/duplicates", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = (page - 1) * limit;

    // Pipeline for Leads
    const leadStage = [
      {
        $addFields: {
          normalizedNumber: {
            $let: {
              vars: {
                digits: { $regexFind: { input: "$contactNumber", regex: /(\d{10})$/ } },
              },
              in: "$$digits.match",
            },
          },
        },
      },
      { $match: { normalizedNumber: { $exists: true, $ne: null, $ne: "" } } },
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
          type: { $literal: "lead" },
        },
      },
    ];

    // We'll use unionWith to bring in Customers with aligned fields
    const pipeline = [
      ...leadStage,
      {
        $unionWith: {
          coll: Customer.collection.name,
          pipeline: [
            {
              $addFields: {
                normalizedNumber: {
                  $let: {
                    vars: {
                      digits: { $regexFind: { input: "$phone", regex: /(\d{10})$/ } },
                    },
                    in: "$$digits.match",
                  },
                },
              },
            },
            { $match: { normalizedNumber: { $exists: true, $ne: null, $ne: "" } } },
            {
              $project: {
                _id: 1,
                name: 1,
                contactNumber: "$phone",
                agentAssigned: null,
                leadStatus: "$leadStatus",
                salesStatus: null,
                healthExpertAssigned: "$assignedTo",
                retentionStatus: null,
                normalizedNumber: 1,
                type: { $literal: "customer" },
              },
            },
          ],
        },
      },
      // Group by normalizedNumber and keep an array of docs
      {
        $group: {
          _id: "$normalizedNumber",
          docs: {
            $push: {
              _id: "$_id",
              name: "$name",
              contactNumber: "$contactNumber",
              agentAssigned: "$agentAssigned",
              leadStatus: "$leadStatus",
              salesStatus: "$salesStatus",
              healthExpertAssigned: "$healthExpertAssigned",
              retentionStatus: "$retentionStatus",
              type: "$type",
            },
          },
          count: { $sum: 1 },
        },
      },
      // Only duplicates (more than one doc with same last-10)
      { $match: { count: { $gt: 1 } } },
      // Optional: sort by count desc then by contact number (string)
      { $sort: { count: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          contactNumber: "$_id",
          leads: "$docs",
        },
      },
      // Facet for pagination + total count
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "totalGroups" }],
        },
      },
      {
        $project: {
          groups: "$data",
          totalGroups: { $ifNull: [{ $arrayElemAt: ["$total.totalGroups", 0] }, 0] },
        },
      },
    ];

    const aggResult = await Lead.aggregate(pipeline).allowDiskUse(true);
    const { groups = [], totalGroups = 0 } = aggResult[0] || {};

    res.json({
      page,
      limit,
      totalGroups,
      groups,
    });
  } catch (err) {
    console.error("Error fetching duplicates:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/duplicate-leads/update-duplicate-group
 */
router.put("/update-duplicate-group", async (req, res) => {
  try {
    const { oldContactNumber, updatedData } = req.body;
    if (!oldContactNumber || !updatedData) {
      return res.status(400).json({ error: "Missing parameters" });
    }
    const normalized = normalizeNumber(oldContactNumber);
    const updateResult = await Lead.updateMany(
      exprMatchLast10Digits("$contactNumber", normalized),
      { $set: updatedData }
    );
    res.json({ message: "Duplicate group updated", updateResult });
  } catch (err) {
    console.error("Error updating duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/duplicate-leads/duplicate-number
 */
router.delete("/duplicate-number", async (req, res) => {
  try {
    const { contactNumber } = req.body;
    if (!contactNumber) {
      return res.status(400).json({ error: "Missing contact number" });
    }
    const normalized = normalizeNumber(contactNumber);

    const leadDeleteResult = await Lead.deleteMany(
      exprMatchLast10Digits("$contactNumber", normalized)
    );
    const customerDeleteResult = await Customer.deleteMany(
      exprMatchLast10Digits("$phone", normalized)
    );

    res.json({
      message: "Leads and Customers with duplicate group deleted",
      leadDeleteResult,
      customerDeleteResult,
    });
  } catch (err) {
    console.error("Error deleting duplicate group:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/duplicate-leads/:type/:id
 */
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

/**
 * DELETE /api/duplicate-leads/cleanup-duplicates
 *
 * Rules unchanged
 */
router.delete("/cleanup-duplicates", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // Leads
    const leads = await Lead.aggregate([
      {
        $addFields: {
          normalizedNumber: {
            $let: {
              vars: { digits: { $regexFind: { input: "$contactNumber", regex: /(\d{10})$/ } } },
              in: "$$digits.match"
            }
          }
        }
      },
      { $match: { normalizedNumber: { $exists: true, $ne: null, $ne: "" } } },
      {
        $project: {
          _id: 1, name: 1,
          contactNumber: 1,
          healthExpertAssigned: 1,
          retentionStatus: 1,
          normalizedNumber: 1,
          createdAt: 1, updatedAt: 1,
          type: { $literal: "lead" }
        }
      }
    ]).session(session);

    // Customers
    const customers = await Customer.aggregate([
      {
        $addFields: {
          normalizedNumber: {
            $let: {
              vars: { digits: { $regexFind: { input: "$phone", regex: /(\d{10})$/ } } },
              in: "$$digits.match"
            }
          }
        }
      },
      { $match: { normalizedNumber: { $exists: true, $ne: null, $ne: "" } } },
      {
        $project: {
          _id: 1, name: 1,
          phone: 1,
          assignedTo: 1,
          normalizedNumber: 1,
          createdAt: 1, updatedAt: 1,
          type: { $literal: "customer" }
        }
      }
    ]).session(session);

    // Group
    const groups = new Map();
    for (const l of leads) {
      if (!groups.has(l.normalizedNumber)) groups.set(l.normalizedNumber, { leads: [], customers: [] });
      groups.get(l.normalizedNumber).leads.push(l);
    }
    for (const c of customers) {
      if (!groups.has(c.normalizedNumber)) groups.set(c.normalizedNumber, { leads: [], customers: [] });
      groups.get(c.normalizedNumber).customers.push(c);
    }

    // Preload Employee docs safely
    const assignedVals = [];
    for (const { customers: C } of groups.values()) {
      for (const c of C) if (c.assignedTo) assignedVals.push(c.assignedTo);
    }

    const objIds = [];
    const names = [];
    for (const v of assignedVals) {
      if (isValidObjectId(v)) objIds.push(new mongoose.Types.ObjectId(v));
      else if (typeof v === "string" && v.trim()) names.push(v.trim());
    }

    const empQueryOr = [];
    if (objIds.length) empQueryOr.push({ _id: { $in: objIds } });
    if (names.length) {
      empQueryOr.push({ fullName: { $in: names } });
      empQueryOr.push({ email: { $in: names } });
    }

    let empDocs = [];
    if (empQueryOr.length) {
      empDocs = await Employee.find({ $or: empQueryOr }).session(session);
    }

    const empById = new Map(empDocs.map(e => [String(e._id), e]));
    const empByName = new Map(empDocs.map(e => [e.fullName?.toLowerCase(), e]));
    const empByEmail = new Map(empDocs.map(e => [e.email?.toLowerCase(), e]));

    function getEmployee(value) {
      if (!value) return null;
      if (isValidObjectId(value)) return empById.get(String(value));
      const k = String(value).toLowerCase();
      return empByName.get(k) || empByEmail.get(k);
    }

    // Decide deletions
    const toDeleteLeadIds = new Set();
    const toDeleteCustomerIds = new Set();

    for (const { leads: L, customers: C } of groups.values()) {
      // Rule 1: Lead Active/Black + HE → delete Customer
      const hasActiveOrBlackLead = L.some(l =>
        ["active", "black"].includes((l.retentionStatus || "").toLowerCase()) &&
        !!l.healthExpertAssigned
      );
      if (hasActiveOrBlackLead && C.length > 0) {
        for (const cust of C) toDeleteCustomerIds.add(String(cust._id));
      }

      // Rule 2: Customers assigned to Admin → delete
      for (const cust of C) {
        const emp = getEmployee(cust.assignedTo);
        if (emp && emp.role && emp.role.toLowerCase() === "admin") {
          toDeleteCustomerIds.add(String(cust._id));
        }
      }

      // Rule 3: Lost Leads → delete
      for (const l of L) {
        if ((l.retentionStatus || "").toLowerCase() === "lost") {
          toDeleteLeadIds.add(String(l._id));
        }
      }
    }

    // Execute deletions
    let leadDeleteResult = { deletedCount: 0 };
    let customerDeleteResult = { deletedCount: 0 };

    if (toDeleteLeadIds.size > 0) {
      leadDeleteResult = await Lead.deleteMany({ _id: { $in: [...toDeleteLeadIds] } }, { session });
    }
    if (toDeleteCustomerIds.size > 0) {
      customerDeleteResult = await Customer.deleteMany({ _id: { $in: [...toDeleteCustomerIds] } }, { session });
    }

    await session.commitTransaction();
    session.endSession();

    return res.json({
      message: "Cleanup completed with new rules",
      summary: {
        leadsDeleted: leadDeleteResult.deletedCount,
        customersDeleted: customerDeleteResult.deletedCount
      },
      deletedLeadIds: [...toDeleteLeadIds],
      deletedCustomerIds: [...toDeleteCustomerIds]
    });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    console.error("Error in cleanup-duplicates:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
