// models/TaskBoard.js
const mongoose = require("mongoose");

const COLUMN_IDS = {
  NEW: "NEW",
  OPEN: "OPEN",
  PAUSED: "PAUSED",
  CLOSED: "CLOSED",
};

const TaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: String,
 
    status: { type: String, required: true, default: COLUMN_IDS.NEW },
 
    assigneeId: String,
    assigneeName: String,
    assignedById: String,
    assignedByName: String,
    assignedDate: Date,
 
    dueDate: Date,
 
    recurring: { type: Boolean, default: false },
    recurringInterval: {
      type: String,
      enum: ["DAILY", "WEEKLY", "MONTHLY"],
      default: "DAILY",
    },
 
    lastRecurringAt: Date,
 
    orderIndex: { type: Number, default: 0 },
 
    attachments: [String],
 
    startedAt: Date,  
    activeSince: Date,  
    totalActiveSeconds: { type: Number, default: 0 },  
    closedAt: Date,  

    notifications: {
      unread: { type: Boolean, default: true },
      notifiedAt: { type: Date, default: Date.now },
    },
  },
  { _id: true, timestamps: true }
);

const ColumnSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },  
    title: { type: String, required: true },
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

const TaskBoardSchema = new mongoose.Schema(
  {
    ownerKey: { type: String, index: true, required: true },  
    columns: [ColumnSchema],
    tasks: [TaskSchema],
  },
  { timestamps: true }
);

const TaskBoard = mongoose.model("TaskBoard", TaskBoardSchema);

module.exports = TaskBoard;
module.exports.TaskBoard = TaskBoard;
module.exports.COLUMN_IDS = COLUMN_IDS;
