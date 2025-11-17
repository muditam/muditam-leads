// routes/globalRetentionSales.js
const express = require("express");
const router = express.Router();
const GlobalRetentionSale = require("../InternationalModel/GlobalRetentionSale");

// GET /api/global-retention-sales
// query: page (1-based), limit, search
router.get("/", async (req, res) => {
  try {
    let { page = 1, limit = 20, search = "" } = req.query;

    page = Math.max(parseInt(page, 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

    const filter = {};

    if (search && search.trim()) {
      const s = search.trim();
      const regex = new RegExp(s, "i");
      filter.$or = [
        { name: regex },
        { contactNumber: regex },
        { orderId: regex },
        { productsOrdered: regex },
      ];
    }

    const skip = (page - 1) * limit;

    const [totalCount, docs] = await Promise.all([
      GlobalRetentionSale.countDocuments(filter),
      GlobalRetentionSale.find(filter)
        .sort({ date: -1, createdAt: -1 }) // reverse chronological
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      sales: docs,
    });
  } catch (err) {
    console.error("GET /api/global-retention-sales error:", err);
    res
      .status(500)
      .json({ message: "Failed to load global retention sales." });
  }
});

// POST /api/global-retention-sales
// body: all fields optional
router.post("/", async (req, res) => {
  try {
    const {
      date,
      name,
      contactNumber,
      productsOrdered,
      dosageOrdered,
      amountPaid,
      orderId,
      orderCreatedBy,
      remarks,
    } = req.body || {};

    let parsedDate = new Date();
    if (date) {
      const d = new Date(date);
      parsedDate = Number.isNaN(d.getTime()) ? new Date() : d;
    }

    const amtNum = Number(amountPaid);
    const amount =
      amountPaid === undefined || amountPaid === null || amountPaid === ""
        ? undefined
        : Number.isFinite(amtNum)
        ? amtNum
        : undefined;

    const sale = await GlobalRetentionSale.create({
      date: parsedDate,
      name: name ? String(name).trim() : undefined,
      contactNumber: contactNumber ? String(contactNumber).trim() : undefined,
      productsOrdered: productsOrdered
        ? String(productsOrdered).trim()
        : undefined,
      dosageOrdered: dosageOrdered ? String(dosageOrdered).trim() : undefined,
      amountPaid: amount,
      orderId: orderId ? String(orderId).trim() : undefined,
      orderCreatedBy: orderCreatedBy
        ? String(orderCreatedBy).trim()
        : undefined,
      remarks: remarks ? String(remarks).trim() : undefined,
    });

    res.status(201).json({
      message: "Global retention sale created.",
      sale,
    });
  } catch (err) {
    console.error("POST /api/global-retention-sales error:", err);
    res
      .status(500)
      .json({ message: "Failed to create global retention sale." });
  }
});

// PATCH /api/global-retention-sales/:id
// partial updates for inline editing
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const updatableFields = [
      "date",
      "name",
      "contactNumber",
      "productsOrdered",
      "dosageOrdered",
      "amountPaid",
      "orderId",
      "orderCreatedBy",
      "remarks",
    ];

    const update = {};

    updatableFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        update[field] = req.body[field];
      }
    });

    if (update.date) {
      const d = new Date(update.date);
      update.date = Number.isNaN(d.getTime()) ? undefined : d;
    }

    if (Object.prototype.hasOwnProperty.call(update, "amountPaid")) {
      const amt = update.amountPaid;
      if (amt === null || amt === "" || amt === undefined) {
        update.amountPaid = undefined;
      } else {
        const num = Number(amt);
        update.amountPaid = Number.isFinite(num) ? num : undefined;
      }
    }

    const sale = await GlobalRetentionSale.findByIdAndUpdate(id, update, {
      new: true,
    });

    if (!sale) {
      return res.status(404).json({ message: "Sale not found." });
    }

    res.json({
      message: "Global retention sale updated.",
      sale,
    });
  } catch (err) {
    console.error("PATCH /api/global-retention-sales/:id error:", err);
    res
      .status(500)
      .json({ message: "Failed to update global retention sale." });
  }
});

// DELETE /api/global-retention-sales/:id
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await GlobalRetentionSale.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Sale not found." });
    }

    res.json({ message: "Global retention sale deleted." });
  } catch (err) {
    console.error("DELETE /api/global-retention-sales/:id error:", err);
    res
      .status(500)
      .json({ message: "Failed to delete global retention sale." });
  }
});

module.exports = router;
