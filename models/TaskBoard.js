const mongoose = require("mongoose");

const COLUMN_IDS = { NEW: "NEW", OPEN: "OPEN", PAUSED: "PAUSED", CLOSED: "CLOSED" };

const TaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: String,

    // Column id (e.g. NEW/OPEN/PAUSED/CLOSED or custom slug)
    status: { type: String, required: true, default: COLUMN_IDS.NEW },

    // Assignment
    assigneeId: String,
    assigneeName: String,
    assignedById: String,
    assignedByName: String,
    assignedDate: Date,

    // Scheduling
    dueDate: Date,

    // Ordering within a column
    orderIndex: { type: Number, default: 0 },

    // Attachments (image URLs)
    attachments: [String],

    // Optional time-tracking fields
    startedAt: Date,
    activeSince: Date,
    totalActiveSeconds: { type: Number, default: 0 },
    closedAt: Date,
  },
  { _id: true, timestamps: true }
);

const ColumnSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // stable app-level id
    title: { type: String, required: true },
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

const TaskBoardSchema = new mongoose.Schema(
  {
    ownerKey: { type: String, index: true, required: true }, // userId from frontend
    columns: [ColumnSchema],
    tasks: [TaskSchema],
  },
  { timestamps: true }
);

const TaskBoard = mongoose.model("TaskBoard", TaskBoardSchema);

module.exports = TaskBoard;
module.exports.TaskBoard = TaskBoard;
module.exports.COLUMN_IDS = COLUMN_IDS;
