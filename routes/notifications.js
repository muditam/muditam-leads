const express = require("express");
const router = express.Router();

const TaskBoard = require("../models/TaskBoard");
const AbandonedCheckout = require("../models/AbandonedCheckout");
const Order = require("../models/Order");
const Escalation = require("../models/escalation.model");

/**
 * ======================================================
 * GET /api/notifications
 * ======================================================
 * Query params:
 *  - fullName (STRING)  ✅ PRIMARY IDENTIFIER
 *  - role (STRING)
 */
router.get("/", async (req, res) => {
  try {
    const { fullName, role } = req.query;

    if (!fullName || !role) {
      return res.status(400).json({
        message: "fullName & role required",
      });
    }

    let notifications = [];

    // ==================================================
    // MANAGER / DEV / MARKETING → TASKS
    // ==================================================
    if (["Manager", "Developer", "Marketing"].includes(role)) {
      const boards = await TaskBoard.find(
        {
          "tasks.assigneeName": fullName,
          "tasks.notifications.unread": true,
        },
        { tasks: 1 }
      ).lean();

      for (const board of boards) {
        for (const task of board.tasks) {
          if (
            task.assigneeName === fullName &&
            task.notifications?.unread === true
          ) {
            notifications.push({
              id: task._id,
              type: "TASK",
              title: task.title,
              message: "New task assigned",
              notifiedAt: task.notifications.notifiedAt || task.createdAt,
            });
          }
        }
      }
    }

    // ==================================================
    // SALES / RETENTION → ABANDONED + RTO
    // ==================================================
    if (["Sales Agent", "Retention Agent"].includes(role)) {
      // ----------------------------
      // Abandoned Carts
      // ----------------------------
      const abandons = await AbandonedCheckout.find({
        "assignedExpert.fullName": fullName,
        notificationRead: false,
      })
        .sort({ createdAt: -1 })
        .lean();

      for (const a of abandons) {
        notifications.push({
          id: a._id,
          type: "ABANDONED_CART",
          title: "New Abandoned Cart",
          message: `₹${((a.total || 0) / 100).toFixed(0)}`,
          notifiedAt: a.createdAt,
        });
      }

      // ----------------------------
      // RTO / RTO Delivered
      // ----------------------------
      const rtos = await Order.find({
        shipment_status: { $in: ["RTO", "RTO Delivered"] },
        "notificationFlags.rtoNotified": false,
      })
        .sort({ last_updated_at: -1 })
        .lean();

      for (const o of rtos) {
        notifications.push({
          id: o._id,
          type: o.shipment_status === "RTO" ? "RTO" : "RTO_DELIVERED",
          title: o.shipment_status,
          message: `Order ${o.order_id}`,
          notifiedAt: o.last_updated_at || o.updatedAt,
        });
      }
    }

    // ==================================================
    // OPERATIONS → ESCALATIONS
    // ==================================================
    if (role === "Operations") {
      const escalations = await Escalation.find({
        status: "Open",
        notificationRead: false,
      })
        .sort({ createdAt: -1 })
        .lean();

      for (const e of escalations) {
        notifications.push({
          id: e._id,
          type: "ESCALATION",
          title: "New Escalation",
          message: e.query || "New escalation raised",
          notifiedAt: e.createdAt,
        });
      }
    }

    // ==================================================
    // SORT — newest first
    // ==================================================
    notifications.sort(
      (a, b) => new Date(b.notifiedAt) - new Date(a.notifiedAt)
    );

    return res.json(notifications);
  } catch (err) {
    console.error("Notification fetch error:", err);
    return res.status(500).json({
      message: "Failed to fetch notifications",
    });
  }
});

 
router.patch("/read", async (req, res) => {
  try {
    const { type, id } = req.body;

    if (!type || !id) {
      return res.status(400).json({
        message: "type & id required",
      });
    }

    if (type === "TASK") {
      await TaskBoard.updateOne(
        { "tasks._id": id },
        { $set: { "tasks.$.notifications.unread": false } }
      );
    }

    if (type === "ABANDONED_CART") {
      await AbandonedCheckout.updateOne(
        { _id: id },
        { $set: { notificationRead: true } }
      );
    }

    if (type === "RTO" || type === "RTO_DELIVERED") {
      await Order.updateOne(
        { _id: id },
        { $set: { "notificationFlags.rtoNotified": true } }
      );
    }

    if (type === "ESCALATION") {
      await Escalation.updateOne(
        { _id: id },
        { $set: { notificationRead: true } }
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Notification read error:", err);
    return res.status(500).json({
      message: "Failed to mark notification read",
    });
  }
});

module.exports = router;
