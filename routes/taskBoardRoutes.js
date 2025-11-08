// routes/taskBoardRoutes.js
const express = require("express");
const router = express.Router();
const TaskBoardModule = require("../models/TaskBoard");

// support either import style
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

// -------- helpers --------
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

function nextOrderIndex(board, status) {
  const inCol = board.tasks.filter((t) => t.status === status);
  if (inCol.length === 0) return 0;
  return Math.max(...inCol.map((t) => t.orderIndex || 0)) + 1;
}

function addActiveSeconds(task, seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  task.totalActiveSeconds = Number(task.totalActiveSeconds || 0) + s;
}

function sortColumns(columns) {
  return [...(columns || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );
}

function sortTasksForBoard(tasks) {
  return [...(tasks || [])].sort((a, b) => {
    if (a.status === b.status) {
      const oi = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
      if (oi !== 0) return oi;
      return (
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime()
      );
    }
    return String(a.status).localeCompare(String(b.status));
  });
}

async function findBoardWithTask(taskId, ownerKey) {
  const scoped = await TaskBoard.findOne({
    ownerKey,
    "tasks._id": taskId,
  });
  if (scoped) return scoped;
  return TaskBoard.findOne({ "tasks._id": taskId });
}

/**
 * Centralised status/timer transition
 * fromStatus -> toStatus
 */
function handleStatusTransition(task, fromStatus, toStatus, now = new Date()) {
  if (!toStatus || fromStatus === toStatus) return;

  const wasOpen = fromStatus === COLUMN_IDS.OPEN;
  const willBeOpen = toStatus === COLUMN_IDS.OPEN;

  // Leaving OPEN: accumulate active time
  if (wasOpen && !willBeOpen && task.activeSince) {
    const deltaSec = Math.floor(
      (now.getTime() - task.activeSince.getTime()) / 1000
    );
    addActiveSeconds(task, deltaSec);
    task.activeSince = null;
  }

  // Entering OPEN: start/resume timer
  if (!wasOpen && willBeOpen) {
    if (!task.startedAt) task.startedAt = now;
    task.activeSince = now;
  }

  // CLOSED timestamp
  if (toStatus === COLUMN_IDS.CLOSED) {
    task.closedAt = now;
  } else if (
    fromStatus === COLUMN_IDS.CLOSED &&
    toStatus !== COLUMN_IDS.CLOSED
  ) {
    // reopening from CLOSED
    task.closedAt = null;
  }

  task.status = toStatus;
}

// -------- Routes --------

// GET board
router.get("/board", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const board = await getOrCreateBoardByOwnerKey(ownerKey);

    const columns = sortColumns(board.columns);

    const validIds = new Set(columns.map((c) => c.id));
    const fallbackId = columns[0]?.id;
    if (fallbackId) {
      let changed = false;
      board.tasks.forEach((t) => {
        if (!validIds.has(t.status)) {
          t.status = fallbackId;
          changed = true;
        }
      });
      if (changed) await board.save();
    }

    const tasks = sortTasksForBoard(board.tasks);

    res.json({ columns, tasks });
  } catch (err) {
    console.error("GET /board error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// CREATE column
router.post("/columns", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const { title, order } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "title is required" });
    }

    const board = await getOrCreateBoardByOwnerKey(ownerKey);

    let proposedId = slugifyColumnId(title);
    const existingIds = new Set(board.columns.map((c) => c.id));
    let uniqueId = proposedId;
    let n = 1;
    while (existingIds.has(uniqueId)) {
      uniqueId = `${proposedId}_${n++}`;
    }

    board.columns.push({
      id: uniqueId,
      title: title.trim(),
      order:
        typeof order === "number" ? order : board.columns.length,
    });
    await board.save();

    const created = board.columns[board.columns.length - 1];
    res.json(created);
  } catch (err) {
    console.error("POST /columns error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// REORDER columns
router.patch("/columns/reorder", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res
        .status(400)
        .json({ message: "orderedIds required" });
    }

    const board = await getOrCreateBoardByOwnerKey(ownerKey);
    const orderMap = new Map(
      orderedIds.map((id, idx) => [String(id), idx])
    );

    board.columns.forEach((c) => {
      const idx = orderMap.get(c.id);
      if (idx !== undefined) c.order = idx;
    });

    await board.save();
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /columns/reorder error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE column (custom lists only)
router.delete("/columns/:id", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const colId = req.params.id;
    const board = await getOrCreateBoardByOwnerKey(ownerKey);

    const defaultIds = new Set(Object.values(COLUMN_IDS));
    if (defaultIds.has(colId)) {
      return res.status(400).json({
        message: "Default columns cannot be deleted",
      });
    }

    const exists = board.columns.some((c) => c.id === colId);
    if (!exists) {
      return res
        .status(404)
        .json({ message: "Column not found" });
    }

    const fallbackId = COLUMN_IDS.NEW || board.columns[0]?.id || colId;

    board.tasks.forEach((t) => {
      if (t.status === colId) {
        t.status = fallbackId;
        t.orderIndex = nextOrderIndex(board, fallbackId);
      }
    });

    board.columns = board.columns.filter((c) => c.id !== colId);

    await board.save();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /columns/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// CREATE task
router.post("/", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const {
      title,
      description,
      status,
      assigneeId,
      assigneeName,
      assignedById,
      assignedByName,
      assignedDate,
      dueDate,
      attachments,
    } = req.body;

    if (!title)
      return res
        .status(400)
        .json({ message: "title is required" });

    const board = await getOrCreateBoardByOwnerKey(ownerKey);

    const validIds = new Set(board.columns.map((c) => c.id));
    const defaultId =
      board.columns[0]?.id || COLUMN_IDS.NEW;
    const safeStatus =
      status && validIds.has(status) ? status : defaultId;

    const now = new Date();

    const task = {
      title: String(title).trim(),
      description: description || "",
      status: safeStatus,
      assigneeId: assigneeId || null,
      assigneeName: assigneeName || "",
      assignedById: assignedById || null,
      assignedByName: assignedByName || "",
      assignedDate: assignedDate ? new Date(assignedDate) : now,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      attachments: Array.isArray(attachments) ? attachments : [],
      orderIndex: nextOrderIndex(board, safeStatus),
      totalActiveSeconds: 0,
      activeSince: null,
      startedAt: null,
      closedAt: null,
    };

    // Initialise timers based on initial status
    if (safeStatus === COLUMN_IDS.OPEN) {
      task.startedAt = now;
      task.activeSince = now;
    } else if (safeStatus === COLUMN_IDS.CLOSED) {
      task.closedAt = now;
    }

    board.tasks.push(task);
    await board.save();

    const created = board.tasks[board.tasks.length - 1];
    res.json(created);
  } catch (err) {
    console.error("POST /tasks error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * IMPORTANT: specific PATCH routes BEFORE generic '/:id'
 */

// Persist reorder within a column
router.patch("/reorder", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const { status, orderedIds } = req.body;
    if (!status || !Array.isArray(orderedIds)) {
      return res.status(400).json({
        message: "status and orderedIds required",
      });
    }

    const board = await getOrCreateBoardByOwnerKey(ownerKey);

    const idToIndex = new Map(
      orderedIds.map((id, idx) => [String(id), idx])
    );

    board.tasks.forEach((t) => {
      if (t.status === status) {
        const idStr = String(t._id || t.id);
        const idx = idToIndex.get(idStr);
        if (idx !== undefined) t.orderIndex = idx;
      }
    });

    await board.save();
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /tasks/reorder error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Timer-aware status changes (DnD)
router.patch("/:id/status", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const taskId = req.params.id;
    const { to } = req.body;

    if (!to)
      return res
        .status(400)
        .json({ message: "Target status 'to' is required" });

    const board = await findBoardWithTask(taskId, ownerKey);
    if (!board)
      return res
        .status(404)
        .json({ message: "Task not found" });

    const task = board.tasks.id(taskId);
    if (!task)
      return res
        .status(404)
        .json({ message: "Task not found" });

    const validIds = new Set(board.columns.map((c) => c.id));
    if (!validIds.has(to)) {
      return res
        .status(400)
        .json({ message: "Invalid target status" });
    }

    const now = new Date();
    const currentStatus = task.status;

    // once OPEN, cannot go back to NEW
    if (
      currentStatus === COLUMN_IDS.OPEN &&
      to === COLUMN_IDS.NEW
    ) {
      return res.status(400).json({
        message: "A started task cannot be moved back to New.",
      });
    }

    // max 2 OPEN
    if (to === COLUMN_IDS.OPEN && currentStatus !== COLUMN_IDS.OPEN) {
      const openCount = board.tasks.filter(
        (t) => t.status === COLUMN_IDS.OPEN
      ).length;
      if (openCount >= 2) {
        return res.status(400).json({
          message:
            "You already have 2 open tasks. Close or pause open tasks first.",
        });
      }
    }

    // apply timer/status transition
    handleStatusTransition(task, currentStatus, to, now);

    // move to end of new column
    task.orderIndex = nextOrderIndex(board, to);

    await board.save();
    res.json(task);
  } catch (err) {
    console.error("PATCH /tasks/:id/status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// UPDATE task (full)
router.put("/:id", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const taskId = req.params.id;
    const {
      title,
      description,
      status,
      assigneeId,
      assigneeName,
      assignedById,
      assignedByName,
      assignedDate,
      dueDate,
      attachments,
    } = req.body;

    const board = await findBoardWithTask(taskId, ownerKey);
    if (!board)
      return res
        .status(404)
        .json({ message: "Task not found" });

    const task = board.tasks.id(taskId);
    if (!task)
      return res
        .status(404)
        .json({ message: "Task not found" });

    if (title !== undefined) task.title = String(title).trim();
    if (description !== undefined) task.description = description;

    const now = new Date();

    if (status !== undefined) {
      const validIds = new Set(board.columns.map((c) => c.id));
      const fromStatus = task.status;
      const toStatus = validIds.has(status)
        ? status
        : board.columns[0]?.id || COLUMN_IDS.NEW;

      handleStatusTransition(task, fromStatus, toStatus, now);

      if (toStatus !== fromStatus) {
        task.orderIndex = nextOrderIndex(board, toStatus);
      }
    }

    if (assigneeId !== undefined) task.assigneeId = assigneeId;
    if (assigneeName !== undefined) task.assigneeName = assigneeName;
    if (assignedById !== undefined) task.assignedById = assignedById;
    if (assignedByName !== undefined) task.assignedByName = assignedByName;
    if (assignedDate !== undefined)
      task.assignedDate = assignedDate
        ? new Date(assignedDate)
        : undefined;

    if (dueDate !== undefined)
      task.dueDate = dueDate ? new Date(dueDate) : undefined;

    if (attachments !== undefined)
      task.attachments = Array.isArray(attachments)
        ? attachments
        : [];

    await board.save();
    res.json(task);
  } catch (err) {
    console.error("PUT /tasks/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH (partial update)
router.patch("/:id", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const taskId = req.params.id;
    const {
      status,
      assigneeId,
      assigneeName,
      assignedById,
      assignedByName,
      assignedDate,
      dueDate,
      attachments,
      title,
      description,
    } = req.body;

    const board = await findBoardWithTask(taskId, ownerKey);
    if (!board)
      return res
        .status(404)
        .json({ message: "Task not found" });

    const task = board.tasks.id(taskId);
    if (!task)
      return res
        .status(404)
        .json({ message: "Task not found" });

    if (title !== undefined) task.title = String(title).trim();
    if (description !== undefined) task.description = description;

    const now = new Date();

    if (status !== undefined) {
      const validIds = new Set(board.columns.map((c) => c.id));
      const fromStatus = task.status;
      const toStatus = validIds.has(status)
        ? status
        : board.columns[0]?.id || COLUMN_IDS.NEW;

      handleStatusTransition(task, fromStatus, toStatus, now);

      if (toStatus !== fromStatus) {
        task.orderIndex = nextOrderIndex(board, toStatus);
      }
    }

    if (assigneeId !== undefined) task.assigneeId = assigneeId;
    if (assigneeName !== undefined) task.assigneeName = assigneeName;
    if (assignedById !== undefined) task.assignedById = assignedById;
    if (assignedByName !== undefined) task.assignedByName = assignedByName;
    if (assignedDate !== undefined)
      task.assignedDate = assignedDate
        ? new Date(assignedDate)
        : undefined;

    if (dueDate !== undefined)
      task.dueDate = dueDate ? new Date(dueDate) : undefined;
    if (attachments !== undefined)
      task.attachments = Array.isArray(attachments)
        ? attachments
        : [];

    await board.save();
    res.json(task);
  } catch (err) {
    console.error("PATCH /tasks/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE task (also delete counterpart on other board if assigned)
router.delete("/:id", async (req, res) => {
  try {
    const ownerKey = requireOwnerKey(req, res);
    if (!ownerKey) return;

    const taskId = req.params.id;

    const board = await findBoardWithTask(taskId, ownerKey);
    if (!board)
      return res
        .status(404)
        .json({ message: "Task not found" });

    const task = board.tasks.id(taskId);
    if (!task)
      return res
        .status(404)
        .json({ message: "Task not found" });

    // capture info BEFORE deleting from this board
    const assignmentInfo = {
      title: task.title,
      assigneeId: task.assigneeId,
      assignedById: task.assignedById,
      assignedDate: task.assignedDate,
    };

    const isDeletingAsAssignee =
      assignmentInfo.assigneeId &&
      ownerKey === assignmentInfo.assigneeId;
    const isDeletingAsAssigner =
      assignmentInfo.assignedById &&
      ownerKey === assignmentInfo.assignedById;

    // delete from current board
    await task.deleteOne();
    await board.save();

    // if this is an assigned task, also delete counterpart copy
    const counterpartOwnerKeys = new Set();
    if (isDeletingAsAssignee && assignmentInfo.assignedById) {
      counterpartOwnerKeys.add(assignmentInfo.assignedById);
    }
    if (isDeletingAsAssigner && assignmentInfo.assigneeId) {
      counterpartOwnerKeys.add(assignmentInfo.assigneeId);
    }

    const assignedDateMs = assignmentInfo.assignedDate
      ? new Date(assignmentInfo.assignedDate).getTime()
      : null;

    for (const otherOwnerKey of counterpartOwnerKeys) {
      const otherBoard = await TaskBoard.findOne({
        ownerKey: otherOwnerKey,
      });
      if (!otherBoard) continue;

      // delete tasks that look like the mirrored assignment
      otherBoard.tasks = otherBoard.tasks.filter((t) => {
        const sameTitle = t.title === assignmentInfo.title;
        const sameAssignee =
          t.assigneeId === assignmentInfo.assigneeId;
        const sameAssigner =
          t.assignedById === assignmentInfo.assignedById;
        const sameAssignedDate =
          !assignedDateMs ||
          (t.assignedDate &&
            new Date(t.assignedDate).getTime() === assignedDateMs);

        const isMatch =
          sameTitle && sameAssignee && sameAssigner && sameAssignedDate;

        return !isMatch; // keep everything except the mirrored tasks 
      });

      await otherBoard.save();
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /tasks/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
