const express = require("express");
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const requireSession = require("../middleware/requireSession");
const router = express.Router();
const { Transform: Json2CsvTransform } = require("json2csv");
const { pipeline, Transform: StreamTransform } = require("stream");

const OPEN_STATUSES = [
  "New Lead",
  "CONS Scheduled",
  "CONS Done",
  "Call Back Later",
  "On Follow Up",
  "CNP",
  "Switch Off",
];

const LOST_STATUSES = [
  "General Query",
  "Fake Lead",
  "Invalid Number",
  "Not Interested-Lost",
  "Ordered from Other Sources",
  "Budget issue",
];

const WON_STATUS = "Sales Done";

const DEAD_STATUSES = [...LOST_STATUSES, "Switch Off"];
const EXCLUDE_STATUSES_FOR_MISSED = [...DEAD_STATUSES, WON_STATUS];

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function normalizeName(name = "") {
  return String(name).trim().replace(/\s+/g, " ");
}

function normalizePhone(phone = "") {
  return String(phone).trim();
}

function normalizeText(value = "") {
  return String(value).trim();
}

function parseJsonSafe(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function toSafeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDayRanges() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const afterTomorrow = new Date(tomorrow);
  afterTomorrow.setDate(afterTomorrow.getDate() + 1);

  return { today, tomorrow, afterTomorrow };
}

function applyBaseFilters({
  match,
  filters = {},
  assignedTo = "",
  createdAt = "",
  userRole = "",
  userName = "",
}) {
  if (filters.search) {
    const regex = new RegExp(String(filters.search).trim(), "i");
    match.$or = [
      { name: { $regex: regex } },
      { phone: { $regex: regex } },
      { location: { $regex: regex } },
    ];
  }

  if (filters.name) {
    match.name = { $regex: String(filters.name).trim(), $options: "i" };
  }

  if (filters.phone) {
    match.phone = normalizePhone(filters.phone);
  }

  if (filters.location) {
    match.location = {
      $regex: String(filters.location).trim(),
      $options: "i",
    };
  }

  if (assignedTo) {
    const assignedArray = String(assignedTo)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    if (assignedArray.length === 1) {
      match.assignedTo = assignedArray[0];
    } else if (assignedArray.length > 1) {
      match.assignedTo = { $in: assignedArray };
    }
  }

  if (
    (userRole === "Sales Agent" || userRole === "Retention Agent") &&
    userName
  ) {
    match.assignedTo = String(userName).trim();
  }

  if (createdAt) {
    const dateStart = toSafeDate(createdAt);
    if (dateStart) {
      dateStart.setHours(0, 0, 0, 0);

      const dateEnd = new Date(dateStart);
      dateEnd.setHours(23, 59, 59, 999);

      match.createdAt = { $gte: dateStart, $lte: dateEnd };
    }
  }
}

function applyStatusFilter(match, status) {
  if (status === "Open") {
    match.leadStatus = { $in: OPEN_STATUSES };
  } else if (status === "Won") {
    match.leadStatus = WON_STATUS;
  } else if (status === "Lost") {
    match.leadStatus = { $in: LOST_STATUSES };
  } else {
    match.leadStatus = { $ne: WON_STATUS };
  }
}

function buildTagClauses(tags = []) {
  const orClauses = [];
  const { today, tomorrow, afterTomorrow } = getDayRanges();

  if (tags.includes("Missed")) {
    orClauses.push({
      $and: [
        { followUpDate: { $lt: today } },
        { leadStatus: { $nin: EXCLUDE_STATUSES_FOR_MISSED } },
      ],
    });
  }

  if (tags.includes("Today")) {
    orClauses.push({ followUpDate: { $gte: today, $lt: tomorrow } });
  }

  if (tags.includes("Tomorrow")) {
    orClauses.push({ followUpDate: { $gte: tomorrow, $lt: afterTomorrow } });
  }

  if (tags.includes("CONS Scheduled")) {
    orClauses.push({ leadStatus: "CONS Scheduled" });
  }

  if (tags.includes("CONS Done")) {
    orClauses.push({ leadStatus: "CONS Done" });
  }

  if (tags.includes("Sales Done")) {
    orClauses.push({ leadStatus: WON_STATUS });
  }

  if (tags.includes("CNP")) {
    orClauses.push({ leadStatus: "CNP" });
  }

  if (tags.includes("On Follow Up")) {
    orClauses.push({ leadStatus: "On Follow Up" });
  }

  if (tags.includes("New Lead")) {
    orClauses.push({ leadStatus: "New Lead" });
  }

  if (tags.includes("Call Back Later")) {
    orClauses.push({ leadStatus: "Call Back Later" });
  }

  return orClauses;
}

function mergeTagClauses(match, orClauses) {
  if (!orClauses.length) return;

  if (match.$or) {
    match.$and = [...(match.$and || []), { $or: orClauses }];
  } else {
    match.$or = orClauses;
  }
}

function buildSortStage(sortBy = "") {
  let sortStage = { createdAt: -1 };

  if (sortBy === "asc") sortStage = { name: 1 };
  if (sortBy === "desc") sortStage = { name: -1 };
  if (sortBy === "oldest") sortStage = { createdAt: 1 };

  return sortStage;
}

router.post("/api/customers", requireSession, async (req, res) => {
  const {
    name,
    phone,
    age,
    location,
    lookingFor,
    assignedTo,
    followUpDate,
    leadSource,
    leadDate,
  } = req.body;

  const normalizedName = normalizeName(name);
  const normalizedPhone = normalizePhone(phone);

  if (
    !normalizedName ||
    !normalizedPhone ||
    age === undefined ||
    age === null ||
    age === "" ||
    !lookingFor ||
    !assignedTo ||
    !followUpDate ||
    !leadSource ||
    !leadDate
  ) {
    return res.status(400).json({ message: "All fields are required." });
  }

  try {
    const existingCustomer = await Customer.findOne({ phone: normalizedPhone });
    if (existingCustomer) {
      return res.status(400).json({ message: "Phone number already exists." });
    }

    const newCustomer = new Customer({
      name: normalizedName,
      phone: normalizedPhone,
      age,
      location: normalizeText(location),
      lookingFor: normalizeText(lookingFor),
      assignedTo: normalizeText(assignedTo),
      followUpDate,
      leadSource: normalizeText(leadSource),
      leadDate,
    });

    await newCustomer.save();

    return res.status(201).json({
      message: "Customer added successfully",
      customer: newCustomer,
    });
  } catch (error) {
    console.error("Error adding customer:", error);
    return res.status(500).json({ message: "Error adding customer" });
  }
});

router.get("/api/customers", requireSession, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const rawSkip =
      req.query.skip !== undefined ? parseInt(req.query.skip, 10) : null;
    const skip = rawSkip !== null && !Number.isNaN(rawSkip) ? rawSkip : null;

    const filters = parseJsonSafe(req.query.filters, {});
    const tags = parseJsonSafe(req.query.tags, []);
    const status = req.query.status || "";
    const sortBy = req.query.sortBy || "";
    const assignedTo = req.query.assignedTo || "";
    const createdAt = req.query.createdAt || "";
    const userRole = req.query.userRole || "";
    const userName = req.query.userName || "";

    const rootMatch = {};

    applyBaseFilters({
      match: rootMatch,
      filters,
      assignedTo,
      createdAt,
      userRole,
      userName,
    });

    applyStatusFilter(rootMatch, status);

    const orClauses = buildTagClauses(Array.isArray(tags) ? tags : []);
    mergeTagClauses(rootMatch, orClauses);

    const sortStage = buildSortStage(sortBy);

    const [customers, total] = await Promise.all([
      Customer.find(rootMatch)
        .sort(sortStage)
        .skip(skip !== null ? skip : (page - 1) * limit)
        .limit(limit),
      Customer.countDocuments(rootMatch),
    ]);

    return res.status(200).json({
      customers,
      totalCustomers: total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
    });
  } catch (err) {
    console.error("Error fetching customers:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/api/customers/counts", requireSession, async (req, res) => {
  try {
    const { role, userName } = req.query;

    const matchStage = {};
    if ((role === "Sales Agent" || role === "Retention Agent") && userName) {
      matchStage.assignedTo = String(userName).trim();
    }

    const { today, tomorrow, afterTomorrow } = getDayRanges();

    const [
      openCount,
      wonCount,
      lostCount,
      todayCount,
      missedCount,
      tomorrowCount,
      newLeadCount,
    ] = await Promise.all([
      Customer.countDocuments({
        ...matchStage,
        leadStatus: { $in: OPEN_STATUSES },
      }),
      Customer.countDocuments({
        ...matchStage,
        leadStatus: WON_STATUS,
      }),
      Customer.countDocuments({
        ...matchStage,
        leadStatus: { $in: LOST_STATUSES },
      }),
      Customer.countDocuments({
        ...matchStage,
        followUpDate: { $gte: today, $lt: tomorrow },
      }),
      Customer.countDocuments({
        ...matchStage,
        followUpDate: { $lt: today },
        leadStatus: { $nin: EXCLUDE_STATUSES_FOR_MISSED },
      }),
      Customer.countDocuments({
        ...matchStage,
        followUpDate: { $gte: tomorrow, $lt: afterTomorrow },
      }),
      Customer.countDocuments({
        ...matchStage,
        leadStatus: "New Lead",
      }),
    ]);

    return res.status(200).json({
      openCount,
      wonCount,
      lostCount,
      todayCount,
      missedCount,
      tomorrowCount,
      newLeadCount,
    });
  } catch (err) {
    console.error("Error fetching counts:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.get("/api/customers/export-csv", requireSession, async (req, res) => {
  try {
    const {
      filters = "{}",
      status = "",
      tags = "[]",
      assignedTo = "",
      createdAt = "",
      userRole = "",
      userName = "",
      sortBy = "newest",
    } = req.query;

    const filtersObj = parseJsonSafe(filters, {});
    const tagsArray = parseJsonSafe(tags, []);

    const match = {};

    applyBaseFilters({
      match,
      filters: filtersObj,
      assignedTo,
      createdAt,
      userRole,
      userName,
    });

    applyStatusFilter(match, status);

    const orClauses = buildTagClauses(Array.isArray(tagsArray) ? tagsArray : []);
    mergeTagClauses(match, orClauses);

    const sortStage = buildSortStage(sortBy);

    const projection = {
      name: 1,
      phone: 1,
      age: 1,
      location: 1,
      lookingFor: 1,
      assignedTo: 1,
      followUpDate: 1,
      leadSource: 1,
      leadDate: 1,
      createdAt: 1,
      dateAndTime: 1,
      leadStatus: 1,
      subLeadStatus: 1,
    };

    const cursor = Customer.find(match, projection)
      .sort(sortStage)
      .lean()
      .cursor({ batchSize: 1000 });

    const toDate = (d) => {
      if (!d) return "";
      const date = new Date(d);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    };

    const toDateTime = (d) => {
      if (!d) return "";
      const date = new Date(d);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    };

    const mapTransform = new StreamTransform({
      readableObjectMode: true,
      writableObjectMode: true,
      transform(doc, _enc, cb) {
        cb(null, {
          name: doc.name || "",
          phone: doc.phone || "",
          age: doc.age ?? "",
          location: doc.location || "",
          lookingFor: doc.lookingFor || "",
          assignedTo: doc.assignedTo || "",
          followUpDate: toDate(doc.followUpDate),
          leadSource: doc.leadSource || "",
          leadDate: toDate(doc.leadDate),
          createdAt: toDate(doc.createdAt),
          dateAndTime: toDateTime(doc.dateAndTime),
          leadStatus: doc.leadStatus || "",
          subLeadStatus: doc.subLeadStatus || "",
        });
      },
    });

    const fields = [
      { label: "Name", value: "name" },
      { label: "Phone", value: "phone" },
      { label: "Age", value: "age" },
      { label: "Location", value: "location" },
      { label: "Looking For", value: "lookingFor" },
      { label: "Assigned To", value: "assignedTo" },
      { label: "Follow Up Date", value: "followUpDate" },
      { label: "Lead Source", value: "leadSource" },
      { label: "Lead Date", value: "leadDate" },
      { label: "Created At", value: "createdAt" },
      { label: "Date and Time", value: "dateAndTime" },
      { label: "Lead Status", value: "leadStatus" },
      { label: "Sub Lead Status", value: "subLeadStatus" },
    ];

    const csvTransform = new Json2CsvTransform(
      { fields, withBOM: true },
      { objectMode: true }
    );

    const fileName = `customers_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    pipeline(cursor, mapTransform, csvTransform, res, (err) => {
      if (err) {
        console.error("CSV stream error:", err);
        if (!res.headersSent) res.status(500).end("Internal Server Error");
      }
    });
  } catch (err) {
    console.error("CSV export setup error:", err);
    if (!res.headersSent) {
      return res.status(500).send("Internal Server Error");
    }
  }
});

router.get("/api/customers/:id", requireSession, async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid customer id" });
    }

    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.status(200).json(customer);
  } catch (error) {
    console.error("Error fetching customer:", error);
    return res.status(500).json({ message: "Error fetching customer" });
  }
});

router.put("/api/customers/:id", requireSession, async (req, res) => {
  const { id } = req.params;
  const {
    name,
    phone,
    age,
    location,
    lookingFor,
    assignedTo,
    followUpDate,
    leadSource,
    leadStatus,
    subLeadStatus,
  } = req.body;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid customer id" });
    }

    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const normalizedPhone = normalizePhone(phone);

    if (normalizedPhone && normalizedPhone !== customer.phone) {
      const existingCustomer = await Customer.findOne({
        phone: normalizedPhone,
        _id: { $ne: id },
      });

      if (existingCustomer) {
        return res.status(400).json({ message: "Phone number already exists." });
      }
    }

    if (name !== undefined) customer.name = normalizeName(name);
    if (phone !== undefined) customer.phone = normalizedPhone;
    if (age !== undefined && age !== "") {
      customer.age = Number(age);
    }
    if (location !== undefined) customer.location = normalizeText(location);
    if (lookingFor !== undefined) customer.lookingFor = normalizeText(lookingFor);
    if (assignedTo !== undefined) customer.assignedTo = normalizeText(assignedTo);
    if (followUpDate !== undefined) customer.followUpDate = followUpDate;
    if (leadSource !== undefined) customer.leadSource = normalizeText(leadSource);
    if (leadStatus !== undefined) customer.leadStatus = normalizeText(leadStatus);
    if (subLeadStatus !== undefined) {
      customer.subLeadStatus = normalizeText(subLeadStatus);
    }

    await customer.save();

    return res.status(200).json({
      message: "Customer updated successfully",
      customer,
    });
  } catch (error) {
    console.error("Error updating customer:", error);
    return res.status(500).json({
      message: "Error updating customer",
      error: error.message,
    });
  }
});

router.delete("/api/customers/:id", requireSession, async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid customer id" });
    }

    const deletedCustomer = await Customer.findByIdAndDelete(id);
    if (!deletedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    return res.status(200).json({ message: "Customer deleted successfully" });
  } catch (error) {
    console.error("Error deleting customer:", error);
    return res.status(500).json({ message: "Error deleting customer" });
  }
});

module.exports = router;