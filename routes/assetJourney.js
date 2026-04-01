const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const AssetAllotment = require("../models/AssetAllotment");
const Asset = require("../models/Add-Asset");
const Employee = require("../models/Employee");

const cleanStr = (v) => (v == null ? "" : String(v).trim());
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

router.get("/:assetCode", async (req, res) => {
  try {
    const assetCode = cleanStr(req.params.assetCode);

    if (!assetCode) {
      return res.status(400).json({ message: "assetCode is required" });
    }

    const rows = await AssetAllotment.find({
      assetCode,
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 })
      .lean();

    const hasOpenHistory = rows.some((r) => cleanStr(r.status) !== "returned");

    if (!hasOpenHistory) {
      const asset = await Asset.findOne({ assetCode }).lean();

      if (
        asset &&
        (cleanStr(asset.allottedTo) || cleanStr(asset.emp_id))
      ) {
        let employee = null;

        if (asset.emp_id && isValidObjectId(asset.emp_id)) {
          employee = await Employee.findById(asset.emp_id)
            .select("fullName email")
            .lean();
        }

        rows.push({
          _id: `legacy-${asset._id}`,
          employee: employee
            ? {
                _id: employee._id,
                fullName: employee.fullName || asset.allottedTo || "",
                email: employee.email || "",
              }
            : asset.allottedTo
            ? {
                _id: null,
                fullName: asset.allottedTo,
                email: "",
              }
            : null,
          name: cleanStr(asset.name),
          company: cleanStr(asset.company),
          model: cleanStr(asset.model),
          assetCode: cleanStr(asset.assetCode),
          allotmentImageUrls: Array.isArray(asset.imageUrls)
            ? asset.imageUrls
            : [],
          returnImageUrls: [],
          allottedAt:
            asset.issuedDate ||
            asset.updatedAt ||
            asset.createdAt ||
            new Date(),
          status: "allocated",
          returnedAt: null,
          notes: "Legacy assigned asset imported from Asset master",
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
          isLegacy: true,
        });
      }
    }

    rows.sort((a, b) => {
      const ad = new Date(a.allottedAt || a.createdAt || 0).getTime();
      const bd = new Date(b.allottedAt || b.createdAt || 0).getTime();
      return ad - bd;
    });

    res.json(rows);
  } catch (err) {
    console.error("GET /asset-journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});

module.exports = router;