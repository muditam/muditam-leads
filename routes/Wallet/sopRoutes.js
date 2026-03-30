const express = require("express");
const SOP = require("../../models/Wallet/SOP");

const router = express.Router();

router.use(express.json());

const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];

function isManager(role = "") {
  return MANAGER_ROLES.includes(String(role).toLowerCase());
}

function requireSession(req, res, next) {
  try {
    const headerUser = req.headers["x-session-user"];

    if (headerUser) {
      req.sessionUser = JSON.parse(headerUser);
      return next();
    }

    if (req.session?.user) {
      req.sessionUser = req.session.user;
      return next();
    }

    return res.status(401).json({ message: "Unauthorized" });
  } catch (error) {
    return res.status(401).json({ message: "Invalid session" });
  }
}

function requireManager(req, res, next) {
  const user = req.sessionUser || {};
  if (isManager(user.role)) return next();
  return res.status(403).json({ message: "Only managers can manage SOPs" });
}

function normalizeName(name = "") {
  return String(name).trim().replace(/\s+/g, " ");
}

// GET all SOPs
router.get("/", requireSession, async (req, res) => {
  try {
    const { activeOnly, rewardType } = req.query;

    const filter = {};

    if (activeOnly === "1" || activeOnly === "true") {
      filter.isActive = true;
    }

    if (rewardType && ["cash", "coin"].includes(String(rewardType).toLowerCase())) {
      filter.rewardType = String(rewardType).toLowerCase();
    }

    const sops = await SOP.find(filter).sort({ createdAt: -1 }).lean();

    return res.json({
      count: sops.length,
      sops,
    });
  } catch (error) {
    console.error("Error fetching SOPs:", error);
    return res.status(500).json({
      message: "Failed to fetch SOPs",
      error: error.message,
    });
  }
});

// GET single SOP
router.get("/:id", requireSession, async (req, res) => {
  try {
    const sop = await SOP.findById(req.params.id).lean();

    if (!sop) {
      return res.status(404).json({ message: "SOP not found" });
    }

    return res.json(sop);
  } catch (error) {
    console.error("Error fetching SOP:", error);
    return res.status(500).json({
      message: "Failed to fetch SOP",
      error: error.message,
    });
  }
});

// CREATE SOP
router.post("/", requireSession, requireManager, async (req, res) => {
  try {
    const user = req.sessionUser || {};
    const { name, value, rewardType, isActive } = req.body;

    const normalizedName = normalizeName(name);

    if (!normalizedName) {
      return res.status(400).json({ message: "name is required" });
    }

    if (value === undefined || value === null || Number.isNaN(Number(value))) {
      return res.status(400).json({ message: "value must be a valid number" });
    }

    const normalizedRewardType = String(rewardType || "").trim().toLowerCase();
    if (!["cash", "coin"].includes(normalizedRewardType)) {
      return res.status(400).json({ message: "rewardType must be cash or coin" });
    }

    const exists = await SOP.findOne({ name: normalizedName });
    if (exists) {
      return res.status(409).json({ message: "SOP with this name already exists" });
    }

    const sop = await SOP.create({
      name: normalizedName,
      value: Number(value),
      rewardType: normalizedRewardType,
      isActive: typeof isActive === "boolean" ? isActive : true,
      createdBy: user.fullName || user.email || "",
      updatedBy: user.fullName || user.email || "",
    });

    return res.status(201).json({
      message: "SOP created successfully",
      sop,
    });
  } catch (error) {
    console.error("Error creating SOP:", error);
    return res.status(500).json({
      message: "Failed to create SOP",
      error: error.message,
    });
  }
});

// UPDATE SOP
router.put("/:id", requireSession, requireManager, async (req, res) => {
  try {
    const user = req.sessionUser || {};
    const { name, value, rewardType, isActive } = req.body;

    const sop = await SOP.findById(req.params.id);
    if (!sop) {
      return res.status(404).json({ message: "SOP not found" });
    }

    if (name !== undefined) {
      const normalizedName = normalizeName(name);

      if (!normalizedName) {
        return res.status(400).json({ message: "name cannot be empty" });
      }

      const duplicate = await SOP.findOne({
        name: normalizedName,
        _id: { $ne: sop._id },
      });

      if (duplicate) {
        return res.status(409).json({ message: "Another SOP with this name already exists" });
      }

      sop.name = normalizedName;
    }

    if (value !== undefined) {
      if (Number.isNaN(Number(value))) {
        return res.status(400).json({ message: "value must be a valid number" });
      }
      sop.value = Number(value);
    }

    if (rewardType !== undefined) {
      const normalizedRewardType = String(rewardType || "").trim().toLowerCase();
      if (!["cash", "coin"].includes(normalizedRewardType)) {
        return res.status(400).json({ message: "rewardType must be cash or coin" });
      }
      sop.rewardType = normalizedRewardType;
    }

    if (isActive !== undefined) {
      sop.isActive = Boolean(isActive);
    }

    sop.updatedBy = user.fullName || user.email || "";

    await sop.save();

    return res.json({
      message: "SOP updated successfully",
      sop,
    });
  } catch (error) {
    console.error("Error updating SOP:", error);
    return res.status(500).json({
      message: "Failed to update SOP",
      error: error.message,
    });
  }
});

// DELETE SOP
router.delete("/:id", requireSession, requireManager, async (req, res) => {
  try {
    const sop = await SOP.findByIdAndDelete(req.params.id);

    if (!sop) {
      return res.status(404).json({ message: "SOP not found" });
    }

    return res.json({
      message: "SOP deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting SOP:", error);
    return res.status(500).json({
      message: "Failed to delete SOP",
      error: error.message,
    });
  }
});

module.exports = router;