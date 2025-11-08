// routes/taskReportingRoutes.js
const express = require("express");
const router = express.Router();
const TaskBoardModule = require("../models/TaskBoard");

const TaskBoard = TaskBoardModule.TaskBoard || TaskBoardModule;
const COLUMN_IDS =
  TaskBoardModule.COLUMN_IDS || {
    NEW: "NEW",
    OPEN: "OPEN",
    PAUSED: "PAUSED",
    CLOSED: "CLOSED",
  };

const DEFAULT_COLUMNS = [
  { title: "New", order: 0, id: COLUMN_IDS.NEW },
  { title: "Open", order: 1, id: COLUMN_IDS.OPEN },
  { title: "Paused", order: 2, id: COLUMN_IDS.PAUSED },
  { title: "Closed", order: 3, id: COLUMN_IDS.CLOSED },
];

// ---------- shared helpers (similar to taskBoardRoutes) ----------
function getOwnerKeyFromReq(req) {
  return req.query.userId || req.body.userId || null;
}

function requireOwnerKey(req, res) {
  const ownerKey = getOwnerKeyFromReq(req);
  if (!ownerKey) {
    res.status(400).json({ message: "userId is required" });
    return null;
  }
  return ownerKey;
}

async function seedDefaultColumnsIfEmpty(board) {
  if (!board.columns || board.columns.length === 0) {
    board.columns = DEFAULT_COLUMNS.map((c) => ({
      id: c.id,
      title: c.title,
      order: c.order,
    }));
    await board.save();
  }
}

function slugifyColumnId(title) {
  if (!title) return `LIST_${Date.now().toString(36)}`;
  const t = String(title).trim();
  const titleMap = {
    New: COLUMN_IDS.NEW,
    Open: COLUMN_IDS.OPEN,
    Paused: COLUMN_IDS.PAUSED,
    Closed: COLUMN_IDS.CLOSED,
  };
  if (titleMap[t]) return titleMap[t];

  return (
    t
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `LIST_${Date.now().toString(36)}`
  );
}

async function migrateMissingColumnIds(board) {
  let changed = false;
  board.columns.forEach((c) => {
    if (!c.id) {
      c.id = slugifyColumnId(c.title);
      changed = true;
    }
  });
  if (changed) {
    const seen = new Set();
    board.columns.forEach((c) => {
      if (seen.has(c.id)) {
        c.id = `${c.id}_${c._id.toString().slice(-4)}`;
      }
      seen.add(c.id);
    });
    await board.save();
  }
}

async function getOrCreateBoardByOwnerKey(ownerKey) {
  let board = await TaskBoard.findOne({ ownerKey });
  if (!board) {
    board = new TaskBoard({
      ownerKey,
      columns: [],
      tasks: [],
    });
    await board.save();
  }
  await seedDefaultColumnsIfEmpty(board);
  await migrateMissingColumnIds(board);
  board.columns.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return board;
}

// ---------- date helpers ----------
function formatYMD(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayYMD() {
  return formatYMD(new Date());
}

function isSameDay(dateVal, ymd) {
  if (!dateVal || !ymd) return false;
  return formatYMD(dateVal) === ymd;
}

function isBetweenInclusive(dateVal, startYMD, endYMD) {
  if (!dateVal || !startYMD || !endYMD) return false;
  const t = new Date(dateVal).getTime();
  const s = new Date(startYMD).getTime();
  const e = new Date(endYMD).getTime();
  return t >= s && t <= e;
}

function isInMonth(dateVal, ym) {
  if (!dateVal || !ym) return false;
  const d = new Date(dateVal);
  const [yStr, mStr] = ym.split("-");
  const y = Number(yStr);
  const m = Number(mStr) - 1;
  return d.getFullYear() === y && d.getMonth() === m;
}

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const diffToMonday = (day + 6) % 7; // 0 for Monday
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - diffToMonday
  );
  const sunday = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 6
  );
  return {
    start: formatYMD(monday),
    end: formatYMD(sunday),
  };
}

function getCurrentMonthValue() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------- time helper ----------
function timeToFinishHours(task) {
  if (!task) return null;

  // Prefer tracked active time
  if (task.totalActiveSeconds) {
    return +(Number(task.totalActiveSeconds) / 3600).toFixed(2);
  }

  // Fallback: closedAt - startedAt
  if (task.startedAt && task.closedAt) {
    const start = new Date(task.startedAt).getTime();
    const end = new Date(task.closedAt).getTime();
    if (end > start) {
      return +((end - start) / (1000 * 60 * 60)).toFixed(2);
    }
  }
  return null;
}

// ---------- main reporting route ----------
//
// GET /api/tasks/reporting
// Required: ?userId=...
// Optional:
//   mode=daily|weekly|monthly (default: daily)
//   For daily:   date=YYYY-MM-DD (default: today)
//   For weekly:  start=YYYY-MM-DD&end=YYYY-MM-DD (default: current week)
//   For monthly: month=YYYY-MM (default: current month)
//
router.get("/", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const mode = String(req.query.mode || "daily").toLowerCase();

    let date = String(req.query.date || "").trim();
    let weekStart = String(req.query.start || "").trim();
    let weekEnd = String(req.query.end || "").trim();
    let month = String(req.query.month || "").trim();

    if (mode === "daily" && !date) {
      date = todayYMD();
    }

    if (mode === "weekly" && (!weekStart || !weekEnd)) {
      const w = getCurrentWeekRange();
      weekStart = weekStart || w.start;
      weekEnd = weekEnd || w.end;
    }

    if (mode === "monthly" && !month) {
      month = getCurrentMonthValue();
    }

    const board = await getOrCreateBoardByOwnerKey(ownerKey);
    const tasks = board.tasks || [];

    const closedTasksRaw = tasks.filter(
      (t) => t.status === COLUMN_IDS.CLOSED
    );
    const openTasksRaw = tasks.filter(
      (t) => t.status === COLUMN_IDS.OPEN
    );

    let closedTasksFiltered = [];
    let openTasks = [];

    if (mode === "daily") {
      closedTasksFiltered = closedTasksRaw.filter((t) =>
        isSameDay(t.closedAt, date)
      );
      openTasks = openTasksRaw; // all current open tasks
    } else if (mode === "weekly") {
      closedTasksFiltered = closedTasksRaw.filter((t) =>
        isBetweenInclusive(t.closedAt, weekStart, weekEnd)
      );
      openTasks = []; // weekly spec: only closed
    } else if (mode === "monthly") {
      closedTasksFiltered = closedTasksRaw.filter((t) =>
        isInMonth(t.closedAt, month)
      );
      openTasks = []; // monthly spec: only closed
    } else {
      // fallback to daily behavior
      const d = date || todayYMD();
      closedTasksFiltered = closedTasksRaw.filter((t) =>
        isSameDay(t.closedAt, d)
      );
      openTasks = openTasksRaw;
    }

    const mapTask = (t) => ({
      id: String(t._id),
      title: t.title,
      description: t.description || "",
      status: t.status,
      assigneeId: t.assigneeId || null,
      assigneeName: t.assigneeName || "",
      assignedById: t.assignedById || null,
      assignedByName: t.assignedByName || "",
      assignedDate: t.assignedDate,
      dueDate: t.dueDate,
      startedAt: t.startedAt,
      closedAt: t.closedAt,
      totalActiveSeconds: t.totalActiveSeconds || 0,
      timeTakenHours: timeToFinishHours(t),
    });

    const closedMapped = closedTasksFiltered.map(mapTask);
    const openMapped = openTasks.map(mapTask);

    const closedCount = closedMapped.length;
    const closedTotalHours = closedMapped.reduce(
      (sum, t) => sum + (t.timeTakenHours || 0),
      0
    );

    const payload = {
      mode,
      window:
        mode === "daily"
          ? { date }
          : mode === "weekly"
          ? { start: weekStart, end: weekEnd }
          : mode === "monthly"
          ? { month }
          : {},
      summary: {
        closedCount,
        closedTotalHours: +closedTotalHours.toFixed(2),
        openCount: openMapped.length,
      },
      closedTasks: closedMapped,
      openTasks: openMapped,
    };

    res.json(payload);
  } catch (err) {
    console.error("GET /tasks/reporting error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
