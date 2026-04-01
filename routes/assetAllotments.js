const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const AssetAllotment = require("../models/AssetAllotment");
const Asset = require("../models/Add-Asset");
const Employee = require("../models/Employee");

const cleanStr = (v) => (v == null ? "" : String(v).trim());
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

const normalizeUrls = (arr) => {
  let urls = Array.isArray(arr) ? arr : [];
  return urls
    .filter(Boolean)
    .map((u) => String(u).trim())
    .filter(Boolean)
    .slice(0, 50);
};

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildLegacyOpenAllotment = async (assetDoc) => {
  let employee = null;

  if (assetDoc.emp_id && isValidObjectId(assetDoc.emp_id)) {
    employee = await Employee.findById(assetDoc.emp_id)
      .select("fullName email")
      .lean();
  }

  return {
    _id: `legacy-${assetDoc._id}`,
    employee: employee
      ? {
          _id: employee._id,
          fullName: employee.fullName || assetDoc.allottedTo || "",
          email: employee.email || "",
        }
      : assetDoc.allottedTo
      ? {
          _id: null,
          fullName: assetDoc.allottedTo,
          email: "",
        }
      : null,
    name: cleanStr(assetDoc.name),
    company: cleanStr(assetDoc.company),
    model: cleanStr(assetDoc.model),
    assetCode: cleanStr(assetDoc.assetCode),
    allotmentImageUrls: Array.isArray(assetDoc.imageUrls)
      ? assetDoc.imageUrls
      : [],
    returnImageUrls: [],
    allottedAt:
      assetDoc.issuedDate ||
      assetDoc.updatedAt ||
      assetDoc.createdAt ||
      new Date(),
    status: "allocated",
    returnedAt: null,
    notes: "Legacy assigned asset imported from Asset master",
    createdAt: assetDoc.createdAt,
    updatedAt: assetDoc.updatedAt,
    isLegacy: true,
  };
};

/* ============================================================
   GET ALL ALLOTMENTS
   Includes AssetAllotment rows + legacy active assignments
============================================================ */
router.get("/", async (_req, res) => {
  try {
    const historyRows = await AssetAllotment.find()
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 })
      .lean();

    const openHistoryCodes = new Set(
      historyRows
        .filter((r) => cleanStr(r.status) !== "returned")
        .map((r) => cleanStr(r.assetCode).toLowerCase())
        .filter(Boolean)
    );

    const legacyAssignedAssets = await Asset.find({
      $or: [
        { allottedTo: { $exists: true, $ne: "" } },
        { emp_id: { $exists: true, $ne: "" } },
      ],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const legacyRows = [];
    for (const asset of legacyAssignedAssets) {
      const code = cleanStr(asset.assetCode).toLowerCase();
      if (!code) continue;
      if (openHistoryCodes.has(code)) continue;

      legacyRows.push(await buildLegacyOpenAllotment(asset));
    }

    const items = [...historyRows, ...legacyRows].sort((a, b) => {
      const ad = new Date(a.allottedAt || a.createdAt || 0).getTime();
      const bd = new Date(b.allottedAt || b.createdAt || 0).getTime();
      return bd - ad;
    });

    res.json(items);
  } catch (err) {
    console.error("GET /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to fetch allotments" });
  }
});

/* ============================================================
   CREATE ALLOTMENT
   Also sync Asset master
============================================================ */
router.post("/", async (req, res) => {
  try {
    const {
      employeeId,
      name,
      company,
      model,
      assetCode,
      allotmentImageUrls,
    } = req.body;

    if (!employeeId || !name || !company || !model || !assetCode) {
      return res.status(400).json({
        message:
          "employeeId, name, company, model, and assetCode are required",
      });
    }

    const emp = await Employee.findById(employeeId);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const cleanAssetCode = cleanStr(assetCode);

    const existingOpen = await AssetAllotment.findOne({
      assetCode: cleanAssetCode,
      status: { $ne: "returned" },
    });

    if (existingOpen) {
      return res.status(409).json({
        message: "This asset is already allocated and not yet returned",
      });
    }

    const imageUrls = normalizeUrls(allotmentImageUrls);
    const now = new Date();

    const doc = await AssetAllotment.create({
      employee: employeeId,
      name: cleanStr(name),
      company: cleanStr(company),
      model: cleanStr(model),
      assetCode: cleanAssetCode,
      allotmentImageUrls: imageUrls,
      status: "allocated",
      allottedAt: now,
    });

    await Asset.findOneAndUpdate(
      { assetCode: cleanAssetCode },
      {
        $set: {
          name: cleanStr(name),
          company: cleanStr(company),
          model: cleanStr(model),
          allottedTo: cleanStr(emp.fullName),
          emp_id: String(emp._id),
          issuedDate: now,
        },
      },
      { new: true }
    );

    const populated = await AssetAllotment.findById(doc._id).populate(
      "employee",
      "fullName email"
    );

    res.status(201).json(populated);
  } catch (err) {
    console.error("POST /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to create allotment" });
  }
});

/* ============================================================
   COLLECT / RETURN ASSET
   Also clear Asset master assignment
============================================================ */
router.patch("/:id/collect", async (req, res) => {
  try {
    const { id } = req.params;
    const { returnedAt, notes, returnImageUrls } = req.body;

    const retDate = returnedAt ? new Date(returnedAt) : new Date();
    if (Number.isNaN(retDate.getTime())) {
      return res.status(400).json({ message: "Invalid returnedAt date" });
    }

    const returnImgs = normalizeUrls(returnImageUrls);

    const doc = await AssetAllotment.findByIdAndUpdate(
      id,
      {
        returnedAt: retDate,
        notes: cleanStr(notes),
        status: "returned",
        returnImageUrls: returnImgs,
      },
      { new: true }
    ).populate("employee", "fullName email");

    if (!doc) {
      return res.status(404).json({ message: "Allotment not found" });
    }

    await Asset.findOneAndUpdate(
      { assetCode: cleanStr(doc.assetCode) },
      {
        $set: {
          allottedTo: "",
          emp_id: "",
        },
      },
      { new: true }
    );

    res.json(doc);
  } catch (err) {
    console.error("PATCH /asset-allotments/:id/collect error:", err);
    res.status(500).json({ message: "Failed to mark as collected" });
  }
});

/* ============================================================
   GET JOURNEY OF AN ASSET
   Returns full history + legacy current assignment if needed
============================================================ */
router.get("/journey/:assetCode", async (req, res) => {
  try {
    const code = cleanStr(req.params.assetCode);
    if (!code) {
      return res.status(400).json({ message: "assetCode is required" });
    }

    const assetCodeRegex = new RegExp(`^${escapeRegex(code)}$`, "i");

    const rows = await AssetAllotment.find({
      assetCode: assetCodeRegex,
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 })
      .lean();

    const hasOpenHistory = rows.some((r) => cleanStr(r.status) !== "returned");

    if (!hasOpenHistory) {
      const asset = await Asset.findOne({
        assetCode: assetCodeRegex,
      }).lean();

      if (asset && (cleanStr(asset.allottedTo) || cleanStr(asset.emp_id))) {
        rows.push(await buildLegacyOpenAllotment(asset));
      }
    }

    rows.sort((a, b) => {
      const ad = new Date(a.allottedAt || a.createdAt || 0).getTime();
      const bd = new Date(b.allottedAt || b.createdAt || 0).getTime();
      return ad - bd;
    });

    const timeline = rows.map((doc) => ({
      _id: doc._id,
      assetCode: doc.assetCode,
      name: doc.name,
      assetName: doc.name,
      company: doc.company,
      model: doc.model,
      employee: doc.employee,
      employeeName: doc.employee?.fullName || "",
      employeeId: doc.employee?._id || null,
      status: doc.status,
      allottedAt: doc.allottedAt,
      returnedAt: doc.returnedAt,
      notes: doc.notes || "",
      allotmentImageUrls: doc.allotmentImageUrls || [],
      returnImageUrls: doc.returnImageUrls || [],
      isLegacy: !!doc.isLegacy,
    }));

    res.json(timeline);
  } catch (err) {
    console.error("GET /asset-allotments/journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});

/* ============================================================
   GET EMPLOYEE ALLOTMENTS
   Includes legacy assigned assets too
============================================================ */
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId) {
      return res.status(400).json({ message: "employeeId is required" });
    }

    const includeReturned =
      String(req.query.includeReturned || "0").trim() === "1";

    const filter = { employee: employeeId };
    if (!includeReturned) {
      filter.status = { $ne: "returned" };
    }

    const historyItems = await AssetAllotment.find(filter)
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 })
      .lean();

    if (includeReturned) {
      return res.json(historyItems);
    }

    const openHistoryCodes = new Set(
      historyItems
        .filter((r) => cleanStr(r.status) !== "returned")
        .map((r) => cleanStr(r.assetCode).toLowerCase())
        .filter(Boolean)
    );

    const legacyAssets = await Asset.find({
      emp_id: String(employeeId),
    }).lean();

    const legacyItems = [];
    for (const asset of legacyAssets) {
      const code = cleanStr(asset.assetCode).toLowerCase();
      if (!code) continue;
      if (openHistoryCodes.has(code)) continue;

      legacyItems.push(await buildLegacyOpenAllotment(asset));
    }

    const items = [...historyItems, ...legacyItems].sort((a, b) => {
      const ad = new Date(a.allottedAt || a.createdAt || 0).getTime();
      const bd = new Date(b.allottedAt || b.createdAt || 0).getTime();
      return bd - ad;
    });

    res.json(items);
  } catch (err) {
    console.error("GET /asset-allotments/employee/:employeeId error:", err);
    res.status(500).json({ message: "Failed to fetch employee allotments" });
  }
});

module.exports = router;