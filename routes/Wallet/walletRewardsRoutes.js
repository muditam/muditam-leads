const express = require("express");

const Employee = require("../../models/Employee");
const Reward = require("../../models/Wallet/Reward");
const CustomRewardRequest = require("../../models/Wallet/CustomRewardRequest");

const router = express.Router();
router.use(express.json());

const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];

function isManager(role = "") {
  return MANAGER_ROLES.includes(String(role || "").toLowerCase());
}

function hasFullAccess(user = {}) {
  return isManager(user.role) || user.hasTeam === true;
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
  if (hasFullAccess(user)) return next();
  return res.status(403).json({ message: "Only managers can perform this action" });
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeUrl(value = "") {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidHttpUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

function getMilestoneByCoinCost(coinCost) {
  const value = Number(coinCost || 0);

  if (value >= 42001 && value <= 48000) {
    return { id: 8, label: "Milestone 8" };
  }
  if (value >= 36001 && value <= 42000) {
    return { id: 7, label: "Milestone 7" };
  }
  if (value >= 30001 && value <= 36000) {
    return { id: 6, label: "Milestone 6" };
  }
  if (value >= 24001 && value <= 30000) {
    return { id: 5, label: "Milestone 5" };
  }
  if (value >= 18001 && value <= 24000) {
    return { id: 4, label: "Milestone 4" };
  }
  if (value >= 12001 && value <= 18000) {
    return { id: 3, label: "Milestone 3" };
  }
  if (value >= 6001 && value <= 12000) {
    return { id: 2, label: "Milestone 2" };
  }
  if (value >= 1 && value <= 6000) {
    return { id: 1, label: "Milestone 1" };
  }

  return { id: null, label: "Outside Milestones" };
}

/* =========================================================
   Rewards
========================================================= */

router.get("/api/rewards", requireSession, async (req, res) => {
  try {
    const { activeOnly, milestoneId, q } = req.query || {};
    const filter = {};

    if (activeOnly === "1" || activeOnly === "true") {
      filter.isActive = true;
    }

    if (
      milestoneId !== undefined &&
      milestoneId !== null &&
      String(milestoneId).trim() !== ""
    ) {
      filter.milestoneId = Number(milestoneId);
    }

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), "i");
      filter.$or = [
        { title: regex },
        { brand: regex },
        { category: regex },
        { milestoneLabel: regex },
      ];
    }

    const rewards = await Reward.find(filter)
      .sort({ milestoneId: 1, coinCost: 1, createdAt: -1 })
      .lean();

    return res.json({
      count: rewards.length,
      rewards,
    });
  } catch (error) {
    console.error("Error fetching rewards:", error);
    return res.status(500).json({
      message: "Failed to fetch rewards",
      error: error.message,
    });
  }
});

router.post("/api/rewards", requireSession, requireManager, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    const {
      title,
      image,
      link,
      price,
      brand,
      category,
      isActive,
    } = req.body || {};

    const finalTitle = normalizeText(title);
    const finalImage = normalizeUrl(image);
    const finalLink = normalizeUrl(link);
    const finalPrice = toNumber(price, 0);
    const finalCoinCost = finalPrice;
    const milestone = getMilestoneByCoinCost(finalCoinCost);

    if (!finalTitle) {
      return res.status(400).json({ message: "Name is required" });
    }

    if (!isValidHttpUrl(finalLink)) {
      return res.status(400).json({ message: "Valid product link is required" });
    }

    if (finalImage && !isValidHttpUrl(finalImage)) {
      return res.status(400).json({ message: "Valid image link is required" });
    }

    if (!finalPrice || finalPrice <= 0) {
      return res.status(400).json({ message: "Price must be greater than 0" });
    }

    const reward = await Reward.create({
      title: finalTitle,
      image: finalImage,
      link: finalLink,
      price: finalPrice,
      coinCost: finalCoinCost,
      brand: normalizeText(brand),
      category: normalizeText(category),
      milestoneId: milestone.id,
      milestoneLabel: milestone.label,
      sourceType: "curated",
      isActive: typeof isActive === "boolean" ? isActive : true,
      createdBy: sessionUser.fullName || sessionUser.email || "",
      updatedBy: sessionUser.fullName || sessionUser.email || "",
    });

    return res.status(201).json({
      message: "Reward created successfully",
      reward,
    });
  } catch (error) {
    console.error("Error creating reward:", error);
    return res.status(500).json({
      message: "Failed to create reward",
      error: error.message,
    });
  }
});

router.put("/api/rewards/:id", requireSession, requireManager, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    const reward = await Reward.findById(req.params.id);

    if (!reward) {
      return res.status(404).json({ message: "Reward not found" });
    }

    const {
      title,
      image,
      link,
      price,
      brand,
      category,
      isActive,
    } = req.body || {};

    if (title !== undefined) {
      const finalTitle = normalizeText(title);
      if (!finalTitle) {
        return res.status(400).json({ message: "Name is required" });
      }
      reward.title = finalTitle;
    }

    if (image !== undefined) {
      const finalImage = normalizeUrl(image);
      if (finalImage && !isValidHttpUrl(finalImage)) {
        return res.status(400).json({ message: "Valid image link is required" });
      }
      reward.image = finalImage;
    }

    if (link !== undefined) {
      const finalLink = normalizeUrl(link);
      if (!isValidHttpUrl(finalLink)) {
        return res.status(400).json({ message: "Valid product link is required" });
      }
      reward.link = finalLink;
    }

    if (price !== undefined) {
      const finalPrice = toNumber(price, 0);
      if (!finalPrice || finalPrice <= 0) {
        return res.status(400).json({ message: "Price must be greater than 0" });
      }

      reward.price = finalPrice;
      reward.coinCost = finalPrice;

      const milestone = getMilestoneByCoinCost(finalPrice);
      reward.milestoneId = milestone.id;
      reward.milestoneLabel = milestone.label;
    }

    if (brand !== undefined) reward.brand = normalizeText(brand);
    if (category !== undefined) reward.category = normalizeText(category);
    if (isActive !== undefined) reward.isActive = Boolean(isActive);

    reward.updatedBy = sessionUser.fullName || sessionUser.email || "";
    await reward.save();

    return res.json({
      message: "Reward updated successfully",
      reward,
    });
  } catch (error) {
    console.error("Error updating reward:", error);
    return res.status(500).json({
      message: "Failed to update reward",
      error: error.message,
    });
  }
});

router.delete("/api/rewards/:id", requireSession, requireManager, async (req, res) => {
  try {
    const reward = await Reward.findByIdAndDelete(req.params.id);

    if (!reward) {
      return res.status(404).json({ message: "Reward not found" });
    }

    return res.json({
      message: "Reward deleted successfully",
      reward,
    });
  } catch (error) {
    console.error("Error deleting reward:", error);
    return res.status(500).json({
      message: "Failed to delete reward",
      error: error.message,
    });
  }
});

/* =========================================================
   Custom reward requests
========================================================= */

router.post("/api/custom-reward", requireSession, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    let {
      agentName,
      url,
      availableCoin,
      startDate,
      endDate,
      milestoneId,
      note,
    } = req.body || {};

    const finalUrl = normalizeUrl(url);

    if (!isValidHttpUrl(finalUrl)) {
      return res.status(400).json({ message: "Valid product link is required" });
    }

    if (hasFullAccess(sessionUser)) {
      if (!normalizeText(agentName)) {
        return res.status(400).json({ message: "agentName is required" });
      }
      agentName = normalizeText(agentName);
    } else {
      agentName = normalizeText(sessionUser.fullName || "");
      if (!agentName) {
        return res.status(403).json({ message: "Agent scope not found in session" });
      }
    }

    const employee = await Employee.findOne(
      { fullName: agentName },
      { _id: 1, fullName: 1, role: 1 }
    ).lean();

    if (!employee) {
      return res.status(404).json({ message: "Agent not found" });
    }

    const finalMilestoneId =
      milestoneId === undefined || milestoneId === null || String(milestoneId).trim() === ""
        ? null
        : Number(milestoneId);

    const requestDoc = await CustomRewardRequest.create({
      agentName,
      employeeId: employee._id || null,
      role: employee.role || "",
      url: finalUrl,
      note: normalizeText(note),
      requestedCoinBudget: toNumber(availableCoin, 0),
      startDate: normalizeText(startDate),
      endDate: normalizeText(endDate),
      milestoneId: finalMilestoneId,
      milestoneLabel: finalMilestoneId !== null ? `Milestone ${finalMilestoneId}` : "",
      status: "pending",
      createdBy: sessionUser.fullName || sessionUser.email || "",
      createdByEmail: sessionUser.email || "",
    });

    return res.status(201).json({
      message: "Custom reward request submitted successfully and is pending approval",
      request: requestDoc,
    });
  } catch (error) {
    console.error("Error submitting custom reward request:", error);
    return res.status(500).json({
      message: "Failed to submit custom reward request",
      error: error.message,
    });
  }
});

router.get("/api/custom-reward/mine", requireSession, async (req, res) => {
  try {
    const sessionUser = req.sessionUser || {};
    const agentName = normalizeText(sessionUser.fullName || "");

    if (!agentName) {
      return res.status(403).json({ message: "Agent scope not found in session" });
    }

    const requests = await CustomRewardRequest.find({ agentName })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("Error fetching own custom reward requests:", error);
    return res.status(500).json({
      message: "Failed to fetch custom reward requests",
      error: error.message,
    });
  }
});

router.get("/api/custom-reward", requireSession, requireManager, async (req, res) => {
  try {
    const { status } = req.query || {};
    const filter = {};

    if (
      status &&
      ["pending", "approved", "rejected"].includes(String(status).trim())
    ) {
      filter.status = String(status).trim();
    }

    const requests = await CustomRewardRequest.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("Error fetching custom reward requests:", error);
    return res.status(500).json({
      message: "Failed to fetch custom reward requests",
      error: error.message,
    });
  }
});

router.post(
  "/api/custom-reward/:id/approve",
  requireSession,
  requireManager,
  async (req, res) => {
    try {
      const sessionUser = req.sessionUser || {};
      const customRequest = await CustomRewardRequest.findById(req.params.id);

      if (!customRequest) {
        return res.status(404).json({ message: "Custom reward request not found" });
      }

      if (customRequest.status !== "pending") {
        return res.status(400).json({
          message: `Request is already ${customRequest.status}`,
        });
      }

      const {
        title,
        image,
        link,
        price,
        brand,
        category,
        isActive,
      } = req.body || {};

      const finalTitle = normalizeText(title);
      const finalImage = normalizeUrl(image);
      const finalLink = normalizeUrl(link || customRequest.url);
      const finalPrice = toNumber(price, 0);
      const finalCoinCost = finalPrice;

      if (!finalTitle) {
        return res.status(400).json({ message: "Name is required for approval" });
      }

      if (!isValidHttpUrl(finalLink)) {
        return res.status(400).json({ message: "Valid product link is required" });
      }

      if (finalImage && !isValidHttpUrl(finalImage)) {
        return res.status(400).json({ message: "Valid image link is required" });
      }

      if (!finalPrice || finalPrice <= 0) {
        return res.status(400).json({ message: "Price must be greater than 0" });
      }

      const milestone = getMilestoneByCoinCost(finalCoinCost);

      const reward = await Reward.create({
        title: finalTitle,
        image: finalImage,
        link: finalLink,
        price: finalPrice,
        coinCost: finalCoinCost,
        brand: normalizeText(brand),
        category: normalizeText(category),
        milestoneId: milestone.id,
        milestoneLabel: milestone.label,
        sourceType: "approved_custom",
        customRewardRequestId: customRequest._id,
        isActive: typeof isActive === "boolean" ? isActive : true,
        createdBy: sessionUser.fullName || sessionUser.email || "",
        updatedBy: sessionUser.fullName || sessionUser.email || "",
      });

      customRequest.status = "approved";
      customRequest.approvedRewardId = reward._id;
      customRequest.reviewedBy = sessionUser.fullName || sessionUser.email || "";
      customRequest.reviewedAt = new Date();

      await customRequest.save();

      return res.json({
        message: "Custom reward request approved successfully",
        reward,
        request: customRequest,
      });
    } catch (error) {
      console.error("Error approving request:", error);
      return res.status(500).json({
        message: "Failed to approve custom reward request",
        error: error.message,
      });
    }
  }
);

router.post(
  "/api/custom-reward/:id/reject",
  requireSession,
  requireManager,
  async (req, res) => {
    try {
      const sessionUser = req.sessionUser || {};
      const { rejectionReason } = req.body || {};

      const customRequest = await CustomRewardRequest.findById(req.params.id);

      if (!customRequest) {
        return res.status(404).json({ message: "Custom reward request not found" });
      }

      if (customRequest.status !== "pending") {
        return res.status(400).json({
          message: `Request is already ${customRequest.status}`,
        });
      }

      customRequest.status = "rejected";
      customRequest.rejectionReason = normalizeText(rejectionReason);
      customRequest.reviewedBy = sessionUser.fullName || sessionUser.email || "";
      customRequest.reviewedAt = new Date();

      await customRequest.save();

      return res.json({
        message: "Custom reward request rejected successfully",
        request: customRequest,
      });
    } catch (error) {
      console.error("Error rejecting request:", error);
      return res.status(500).json({
        message: "Failed to reject custom reward request",
        error: error.message,
      });
    }
  }
);

module.exports = router;