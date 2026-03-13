const express = require("express");
const router = express.Router();

const Script = require("../marketing/marketingschema/scriptSchema");
const AdsVideo = require("../marketing/marketingschema/adsVideoSchema");
const OtherVideo = require("../marketing/marketingschema/otherVideoSchema");
const StaticCarousel = require("../marketing/marketingschema/staticCarouselSchema");

const MANAGER_ROLES = ["admin", "manager", "super-admin", "team-leader"];

const isManager = (role = "") =>
  MANAGER_ROLES.includes(String(role || "").toLowerCase());

const hasFullAccess = (user = {}) =>
  isManager(user.role) || user.hasTeam === true;

const MODEL_CONFIGS = [
  {
    key: "script",
    label: "Script",
    model: Script,
    idField: "scriptId",
    reviewStatusField: "scriptStatus",
    startStage: "Script",
  },
  {
    key: "adsVideo",
    label: "Ads Video",
    model: AdsVideo,
    idField: "adsVideoId",
    reviewStatusField: "ideationStatus",
    startStage: "Ideation",
  },
  {
    key: "staticCarousel",
    label: "Static Carousel",
    model: StaticCarousel,
    idField: "staticCarouselId",
    reviewStatusField: "ideationStatus",
    startStage: "Ideation",
  },
  {
    key: "otherVideo",
    label: "Other Video",
    model: OtherVideo,
    idField: "otherVideoId",
    reviewStatusField: "scriptStatus",
    startStage: "Ideation",
  },
];

const PUBLISH_STATUSES = ["Posted", "Used in Ads"];
const BLOCKED_EDIT_STATUSES = ["Re-edit", "Reshoot", "On Hold"];
const BLOCKED_POST_STATUSES = ["Re-edit", "Reshoot", "On Hold", "Rejected"];
const PENDING_NO_ACTION_STAGES = ["Shoot Pending", "Cut Done", "Edit Pending"];

/* ──────────────────────────────────────────────────────────
   CACHE
   In-memory TTL cache
   summary/report = 60s
   list/drill-down routes = 30s
   refresh=1 bypasses cache
   ────────────────────────────────────────────────────────── */

const DASHBOARD_CACHE_TTL_MS = Number(
  process.env.MARKETING_DASHBOARD_CACHE_TTL_MS || 60 * 1000
);
const DASHBOARD_LIST_CACHE_TTL_MS = Number(
  process.env.MARKETING_DASHBOARD_LIST_CACHE_TTL_MS || 30 * 1000
);
const DASHBOARD_CACHE_MAX_KEYS = Number(
  process.env.MARKETING_DASHBOARD_CACHE_MAX_KEYS || 500
);

const dashboardCache = new Map();

function stableStringify(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function normalizeCacheUser(user = {}) {
  return {
    fullName: String(user.fullName || "").trim(),
    email: String(user.email || "").trim().toLowerCase(),
    role: String(user.role || "").trim().toLowerCase(),
    hasTeam: user.hasTeam === true,
  };
}

function pruneDashboardCache() {
  const now = Date.now();

  for (const [key, entry] of dashboardCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      dashboardCache.delete(key);
    }
  }

  if (dashboardCache.size <= DASHBOARD_CACHE_MAX_KEYS) return;

  const extra = dashboardCache.size - DASHBOARD_CACHE_MAX_KEYS;
  const oldestKeys = [...dashboardCache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, extra)
    .map(([key]) => key);

  oldestKeys.forEach((key) => dashboardCache.delete(key));
}

function getDashboardCache(cacheKey) {
  const entry = dashboardCache.get(cacheKey);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    dashboardCache.delete(cacheKey);
    return null;
  }

  return entry.payload;
}

function setDashboardCache(cacheKey, payload, ttlMs = DASHBOARD_CACHE_TTL_MS) {
  pruneDashboardCache();

  const now = Date.now();
  dashboardCache.set(cacheKey, {
    payload,
    createdAt: now,
    expiresAt: now + Math.max(1000, ttlMs),
  });

  if (dashboardCache.size > DASHBOARD_CACHE_MAX_KEYS) {
    pruneDashboardCache();
  }

  return payload;
}

function clearDashboardCache() {
  dashboardCache.clear();
}

function shouldBypassCache(req) {
  const refresh = String(req.query.refresh || "").trim().toLowerCase();
  return refresh === "1" || refresh === "true" || refresh === "yes";
}

function buildDashboardCacheKey(req, extraKey = "") {
  return stableStringify({
    path: `${req.baseUrl || ""}${req.path || ""}`,
    query: req.query || {},
    user: normalizeCacheUser(req.sessionUser || {}),
    extraKey,
  });
}

async function respondWithCache(req, res, builder, options = {}) {
  const {
    ttlMs = DASHBOARD_CACHE_TTL_MS,
    extraKey = "",
  } = options;

  const bypass = shouldBypassCache(req);
  const cacheKey = buildDashboardCacheKey(req, extraKey);

  // browser should not cache; only server-side memory cache should apply
  res.set("Cache-Control", "private, no-store");

  if (!bypass) {
    const cached = getDashboardCache(cacheKey);
    if (cached) {
      res.set("X-Dashboard-Cache", "HIT");
      return res.json(cached);
    }
  }

  const payload = await builder();
  setDashboardCache(cacheKey, payload, ttlMs);

  res.set("X-Dashboard-Cache", bypass ? "BYPASS" : "MISS");
  return res.json(payload);
}

/* optional: lets other route files clear dashboard cache after mutations */
router.clearDashboardCache = clearDashboardCache;

const requireSession = (req, res, next) => {
  try {
    const headerUser = req.headers["x-session-user"];
    if (headerUser) {
      const parsed = JSON.parse(headerUser);
      if (parsed?.fullName) {
        req.sessionUser = parsed;
        return next();
      }
    }
  } catch (_) {}

  if (req.session?.user?.fullName) {
    req.sessionUser = req.session.user;
    return next();
  }

  return res.status(401).json({ message: "Unauthorized" });
};

function buildDateRange(dateFrom, dateTo) {
  const range = {};

  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d)) {
      range.$gte = new Date(d.toISOString().split("T")[0] + "T00:00:00.000Z");
    }
  }

  if (dateTo) {
    const d = new Date(dateTo);
    if (!isNaN(d)) {
      range.$lte = new Date(d.toISOString().split("T")[0] + "T23:59:59.999Z");
    }
  }

  return Object.keys(range).length ? range : null;
}

function buildRangeFromPreset(dateRange, customStart, customEnd) {
  const now = new Date();

  if (!dateRange || dateRange === "all") return null;

  if (dateRange === "today") {
    const s = new Date(now);
    s.setHours(0, 0, 0, 0);
    const e = new Date(now);
    e.setHours(23, 59, 59, 999);
    return { $gte: s, $lte: e };
  }

  if (dateRange === "yesterday") {
    const s = new Date(now);
    s.setDate(s.getDate() - 1);
    s.setHours(0, 0, 0, 0);

    const e = new Date(now);
    e.setDate(e.getDate() - 1);
    e.setHours(23, 59, 59, 999);

    return { $gte: s, $lte: e };
  }

  if (dateRange === "last7") {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    s.setHours(0, 0, 0, 0);
    return { $gte: s, $lte: now };
  }

  if (dateRange === "last30") {
    const s = new Date(now);
    s.setDate(s.getDate() - 29);
    s.setHours(0, 0, 0, 0);
    return { $gte: s, $lte: now };
  }

  if (dateRange === "lastMonth") {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { $gte: s, $lte: e };
  }

  if (dateRange === "custom" && customStart && customEnd) {
    const s = new Date(customStart + "T00:00:00.000Z");
    const e = new Date(customEnd + "T23:59:59.999Z");
    if (!isNaN(s) && !isNaN(e)) return { $gte: s, $lte: e };
  }

  return null;
}

function andFilters(...filters) {
  const valid = filters.filter((f) => f && Object.keys(f).length);
  if (!valid.length) return {};
  if (valid.length === 1) return valid[0];
  return { $and: valid };
}

function getUserIdentity(user = {}) {
  return {
    fullName: String(user.fullName || "").trim(),
    email: String(user.email || "").trim().toLowerCase(),
  };
}

function buildRecordScopeFilter(user = {}) {
  if (hasFullAccess(user)) return {};

  const { fullName, email } = getUserIdentity(user);
  const ors = [];

  if (fullName) {
    ors.push(
      { createdBy: fullName },
      { shootDoneBy: fullName },
      { cutDoneBy: fullName },
      { cutUploadedBy: fullName },
      { editAssignedTo: fullName },
      { editDoneBy: fullName },
      { postedBy: fullName }
    );
  }

  if (email) {
    ors.push({ createdByEmail: email });
  }

  return ors.length ? { $or: ors } : { _id: null };
}

function buildActorFilter(field, user = {}) {
  if (hasFullAccess(user)) {
    return { [field]: { $exists: true, $ne: "" } };
  }

  const { fullName, email } = getUserIdentity(user);

  if (field === "createdBy") {
    const ors = [];
    if (fullName) ors.push({ createdBy: fullName });
    if (email) ors.push({ createdByEmail: email });

    if (!ors.length) return { _id: null };
    if (ors.length === 1) return ors[0];
    return { $or: ors };
  }

  if (!fullName) return { _id: null };
  return { [field]: fullName };
}

function getScopedName(user = {}, requestedName = "") {
  if (hasFullAccess(user)) return String(requestedName || "").trim();
  return String(user.fullName || "").trim();
}

function normalizeCountMap(rows = []) {
  const map = {};
  rows.forEach((r) => {
    const key = r?._id == null || r?._id === "" ? "Unknown" : String(r._id);
    map[key] = (map[key] || 0) + Number(r.count || 0);
  });
  return map;
}

function mergeCountMaps(target = {}, source = {}) {
  Object.entries(source || {}).forEach(([k, v]) => {
    target[k] = (target[k] || 0) + Number(v || 0);
  });
  return target;
}

function countArrayToSortedList(map = {}) {
  return Object.entries(map)
    .map(([key, count]) => ({ _id: key, count }))
    .sort((a, b) => b.count - a.count || String(a._id).localeCompare(String(b._id)));
}

function buildSelectFields(cfg, extra = []) {
  const base = [
    cfg.idField,
    cfg.reviewStatusField,
    "stage",
    "createdAt",
    "updatedAt",
    "createdBy",
    "createdByEmail",
    "approvedBy",
    "approvedAt",
    "approverComment",
    "postPublishStatus",
    "postedAt",
    "postedBy",
    "editAssignedTo",
    "editStatus",
    "postStatus",
    "cutDoneAt",
    "cutDoneBy",
    "cutUploadedBy",
    "editDoneAt",
    "editDoneBy",
    "shootDoneAt",
    "shootDoneBy",
    "scriptType",
    "adType",
    "contentType",
    "title",
    "referenceLink",
  ];

  return [...new Set([...base, ...extra])].join(" ");
}

function normalizeListItem(doc, cfg) {
  return {
    ...doc,
    schemaKey: cfg.key,
    schemaLabel: cfg.label,
  };
}

function sortByDateDesc(items = [], primary = "updatedAt", fallback = "createdAt") {
  return items.sort((a, b) => {
    const aTime = new Date(a?.[primary] || a?.[fallback] || 0).getTime();
    const bTime = new Date(b?.[primary] || b?.[fallback] || 0).getTime();
    return bTime - aTime;
  });
}

async function getSchemaSummary(cfg, recordScope, createdRange) {
  const createdAtFilter = createdRange ? { createdAt: createdRange } : {};
  const postedAtFilter = createdRange ? { postedAt: createdRange } : {};
  const baseCreatedFilter = andFilters(recordScope, createdAtFilter);

  const blockedBase = {
    $or: [
      { editStatus: { $in: BLOCKED_EDIT_STATUSES } },
      { postStatus: { $in: BLOCKED_POST_STATUSES } },
    ],
  };

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const [
    total,
    stageAgg,
    statusAgg,
    postedCount,
    usedInAdsCount,
    blockedTotal,
    reEditCount,
    reshootCount,
    onHoldCount,
    pendingWithoutAction,
  ] = await Promise.all([
    cfg.model.countDocuments(baseCreatedFilter),

    cfg.model.aggregate([
      { $match: baseCreatedFilter },
      { $group: { _id: "$stage", count: { $sum: 1 } } },
    ]),

    cfg.model.aggregate([
      { $match: baseCreatedFilter },
      { $group: { _id: `$${cfg.reviewStatusField}`, count: { $sum: 1 } } },
    ]),

    cfg.model.countDocuments(
      andFilters(recordScope, { postPublishStatus: "Posted" }, postedAtFilter)
    ),

    cfg.model.countDocuments(
      andFilters(recordScope, { postPublishStatus: "Used in Ads" }, postedAtFilter)
    ),

    cfg.model.countDocuments(andFilters(recordScope, createdAtFilter, blockedBase)),

    cfg.model.countDocuments(
      andFilters(recordScope, createdAtFilter, {
        $or: [{ editStatus: "Re-edit" }, { postStatus: "Re-edit" }],
      })
    ),

    cfg.model.countDocuments(
      andFilters(recordScope, createdAtFilter, {
        $or: [{ editStatus: "Reshoot" }, { postStatus: "Reshoot" }],
      })
    ),

    cfg.model.countDocuments(
      andFilters(recordScope, createdAtFilter, {
        $or: [{ editStatus: "On Hold" }, { postStatus: "On Hold" }],
      })
    ),

    cfg.model.countDocuments(
      andFilters(recordScope, createdAtFilter, {
        stage: { $in: PENDING_NO_ACTION_STAGES },
        updatedAt: { $lt: threeDaysAgo },
      })
    ),
  ]);

  return {
    total,
    stageCounts: normalizeCountMap(stageAgg),
    approval: normalizeCountMap(statusAgg),
    published: {
      posted: postedCount,
      usedInAds: usedInAdsCount,
      total: postedCount + usedInAdsCount,
    },
    blocked: {
      total: blockedTotal,
      reEdit: reEditCount,
      reshoot: reshootCount,
      onHold: onHoldCount,
    },
    pendingWithoutAction,
    bufferCount: blockedTotal,
  };
}

async function buildWriterMetrics(user, createdRange) {
  const createdAtFilter = createdRange ? { createdAt: createdRange } : {};
  const filter = andFilters(buildActorFilter("createdBy", user), createdAtFilter);

  const map = new Map();

  const results = await Promise.all(
    MODEL_CONFIGS.map((cfg) =>
      cfg.model
        .find(filter)
        .select(buildSelectFields(cfg))
        .lean()
    )
  );

  results.forEach((docs, idx) => {
    const cfg = MODEL_CONFIGS[idx];

    docs.forEach((doc) => {
      const name = String(doc.createdBy || "").trim() || "Unknown";
      if (!map.has(name)) {
        map.set(name, {
          name,
          totalWritten: 0,
          approved: 0,
          pendingReview: 0,
          rewrite: 0,
          onHold: 0,
          rejected: 0,
          posted: 0,
        });
      }

      const row = map.get(name);
      const reviewStatus = String(doc[cfg.reviewStatusField] || "").trim();

      row.totalWritten += 1;
      if (reviewStatus === "Approved") row.approved += 1;
      if (reviewStatus === "Pending") row.pendingReview += 1;
      if (reviewStatus === "Rewrite") row.rewrite += 1;
      if (reviewStatus === "On Hold") row.onHold += 1;
      if (reviewStatus === "Rejected") row.rejected += 1;

      if (
        PUBLISH_STATUSES.includes(String(doc.postPublishStatus || "").trim()) ||
        doc.postedAt
      ) {
        row.posted += 1;
      }
    });
  });

  return [...map.values()].sort(
    (a, b) => b.totalWritten - a.totalWritten || a.name.localeCompare(b.name)
  );
}

async function buildEditorMetrics(user, createdRange) {
  const createdAtFilter = createdRange ? { createdAt: createdRange } : {};
  const filter = andFilters(
    buildActorFilter("editAssignedTo", user),
    createdAtFilter,
    { editAssignedTo: { $exists: true, $ne: "" } }
  );

  const map = new Map();

  const results = await Promise.all(
    MODEL_CONFIGS.map((cfg) =>
      cfg.model
        .find(filter)
        .select(buildSelectFields(cfg))
        .lean()
    )
  );

  results.forEach((docs) => {
    docs.forEach((doc) => {
      const name = String(doc.editAssignedTo || "").trim();
      if (!name) return;

      if (!map.has(name)) {
        map.set(name, {
          name,
          assigned: 0,
          completed: 0,
          pending: 0,
          blocked: 0,
          reEdit: 0,
          reshoot: 0,
          onHold: 0,
          avgTurnaround: null,
          _tatCount: 0,
          _tatTotalHours: 0,
        });
      }

      const row = map.get(name);

      row.assigned += 1;

      if (doc.editDoneAt || ["Edit Done", "Post"].includes(doc.stage)) {
        row.completed += 1;
      }

      if (["Edit Pending", "Cut Done"].includes(doc.stage)) {
        row.pending += 1;
      }

      const isReEdit =
        doc.editStatus === "Re-edit" || doc.postStatus === "Re-edit";
      const isReshoot =
        doc.editStatus === "Reshoot" || doc.postStatus === "Reshoot";
      const isOnHold =
        doc.editStatus === "On Hold" || doc.postStatus === "On Hold";
      const isBlocked =
        isReEdit ||
        isReshoot ||
        isOnHold ||
        doc.postStatus === "Rejected";

      if (isReEdit) row.reEdit += 1;
      if (isReshoot) row.reshoot += 1;
      if (isOnHold) row.onHold += 1;
      if (isBlocked) row.blocked += 1;

      if (doc.cutDoneAt && doc.editDoneAt) {
        const hours =
          (new Date(doc.editDoneAt).getTime() - new Date(doc.cutDoneAt).getTime()) /
          (1000 * 60 * 60);

        if (!isNaN(hours) && isFinite(hours) && hours >= 0) {
          row._tatTotalHours += hours;
          row._tatCount += 1;
        }
      }
    });
  });

  return [...map.values()]
    .map((row) => ({
      name: row.name,
      assigned: row.assigned,
      completed: row.completed,
      pending: row.pending,
      blocked: row.blocked,
      reEdit: row.reEdit,
      reshoot: row.reshoot,
      onHold: row.onHold,
      avgTurnaround:
        row._tatCount > 0 ? Math.round(row._tatTotalHours / row._tatCount) : null,
    }))
    .sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
}

async function fetchAcrossSchemas(buildFilterForCfg, selectBuilder, sortField = "updatedAt") {
  const results = await Promise.all(
    MODEL_CONFIGS.map(async (cfg) => {
      const filter = buildFilterForCfg(cfg);
      if (!filter || (filter._id && filter._id === null)) return [];

      const docs = await cfg.model
        .find(filter)
        .select(selectBuilder(cfg))
        .lean();

      return docs.map((doc) => normalizeListItem(doc, cfg));
    })
  );

  return sortByDateDesc(results.flat(), sortField, "createdAt");
}

async function getOverallPublishBreakdown(recordScope, postedRange) {
  const publishMap = {};

  const results = await Promise.all(
    MODEL_CONFIGS.map((cfg) =>
      cfg.model
        .find(
          andFilters(
            recordScope,
            { postedAt: { $exists: true, $ne: null } },
            postedRange ? { postedAt: postedRange } : {}
          )
        )
        .select("postPublishStatus postedAt")
        .lean()
    )
  );

  results.flat().forEach((doc) => {
    const key =
      String(doc.postPublishStatus || "").trim() || "Not Published";
    publishMap[key] = (publishMap[key] || 0) + 1;
  });

  return countArrayToSortedList(publishMap);
}

async function buildBySchemaObject(recordScope, createdRange) {
  const entries = await Promise.all(
    MODEL_CONFIGS.map(async (cfg) => [
      cfg.key,
      await getSchemaSummary(cfg, recordScope, createdRange),
    ])
  );

  return Object.fromEntries(entries);
}

/* ────────────────────────────────────────────────────────────
   GET /summary
   ──────────────────────────────────────────────────────────── */
router.get("/summary", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { dateFrom, dateTo } = req.query;

        const createdRange = buildDateRange(dateFrom, dateTo);
        const recordScope = buildRecordScopeFilter(user);

        const [bySchema, writerMetrics, editorMetrics] = await Promise.all([
          buildBySchemaObject(recordScope, createdRange),
          buildWriterMetrics(user, createdRange),
          buildEditorMetrics(user, createdRange),
        ]);

        const overallStageCounts = {};
        const overallPublished = { posted: 0, usedInAds: 0, total: 0 };
        const overallBlocked = { total: 0, reEdit: 0, reshoot: 0, onHold: 0 };

        let totalContent = 0;
        let pendingWithoutAction = 0;

        Object.values(bySchema).forEach((schema) => {
          totalContent += Number(schema.total || 0);
          pendingWithoutAction += Number(schema.pendingWithoutAction || 0);

          mergeCountMaps(overallStageCounts, schema.stageCounts || {});

          overallPublished.posted += Number(schema.published?.posted || 0);
          overallPublished.usedInAds += Number(schema.published?.usedInAds || 0);
          overallPublished.total += Number(schema.published?.total || 0);

          overallBlocked.total += Number(schema.blocked?.total || 0);
          overallBlocked.reEdit += Number(schema.blocked?.reEdit || 0);
          overallBlocked.reshoot += Number(schema.blocked?.reshoot || 0);
          overallBlocked.onHold += Number(schema.blocked?.onHold || 0);
        });

        return {
          totalContent,
          totalScripts: totalContent,
          bySchema,
          stageCounts: overallStageCounts,
          published: overallPublished,
          pendingWithoutAction,
          blocked: overallBlocked,
          writerMetrics,
          editorMetrics,
        };
      },
      { ttlMs: DASHBOARD_CACHE_TTL_MS, extraKey: "summary-v1" }
    );
  } catch (err) {
    console.error("Dashboard summary error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /report
   ──────────────────────────────────────────────────────────── */
router.get("/report", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { dateRange, customStart, customEnd } = req.query;

        const range = buildRangeFromPreset(dateRange, customStart, customEnd);
        const recordScope = buildRecordScopeFilter(user);

        const bySchema = await buildBySchemaObject(recordScope, range);

        const summary = {
          totalContent: 0,
          totalScripts: Number(bySchema.script?.total || 0),
          totalAdsVideo: Number(bySchema.adsVideo?.total || 0),
          totalStaticCarousel: Number(bySchema.staticCarousel?.total || 0),
          totalOtherVideo: Number(bySchema.otherVideo?.total || 0),
          totalShoots: 0,
          totalCuts: 0,
          totalEdits: 0,
          totalPosts: 0,
        };

        for (const cfg of MODEL_CONFIGS) {
          const [shoots, cuts, edits, posts] = await Promise.all([
            cfg.model.countDocuments(
              andFilters(
                recordScope,
                { shootDoneAt: { $exists: true, $ne: null } },
                range ? { shootDoneAt: range } : {}
              )
            ),
            cfg.model.countDocuments(
              andFilters(
                recordScope,
                { cutDoneAt: { $exists: true, $ne: null } },
                range ? { cutDoneAt: range } : {}
              )
            ),
            cfg.model.countDocuments(
              andFilters(
                recordScope,
                { editDoneAt: { $exists: true, $ne: null } },
                range ? { editDoneAt: range } : {}
              )
            ),
            cfg.model.countDocuments(
              andFilters(
                recordScope,
                { postedAt: { $exists: true, $ne: null } },
                range ? { postedAt: range } : {}
              )
            ),
          ]);

          summary.totalShoots += shoots;
          summary.totalCuts += cuts;
          summary.totalEdits += edits;
          summary.totalPosts += posts;
        }

        summary.totalContent =
          summary.totalScripts +
          summary.totalAdsVideo +
          summary.totalStaticCarousel +
          summary.totalOtherVideo;

        const publish = await getOverallPublishBreakdown(recordScope, range);

        return {
          summary,
          bySchema,
          publish,
          boards: {},
        };
      },
      { ttlMs: DASHBOARD_CACHE_TTL_MS, extraKey: "report-v1" }
    );
  } catch (err) {
    console.error("Report route error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /scripts-by-stage
   ──────────────────────────────────────────────────────────── */
router.get("/scripts-by-stage", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { stage, dateFrom, dateTo } = req.query;

        if (!stage) {
          return { __error: { code: 400, message: "stage required" } };
        }

        const createdRange = buildDateRange(dateFrom, dateTo);
        const recordScope = buildRecordScopeFilter(user);
        const stageList = String(stage)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const items = await fetchAcrossSchemas(
          () =>
            andFilters(
              recordScope,
              stageList.length > 1 ? { stage: { $in: stageList } } : { stage: stageList[0] },
              createdRange ? { createdAt: createdRange } : {}
            ),
          (cfg) => buildSelectFields(cfg),
          "updatedAt"
        );

        const sliced = items.slice(0, 300);

        return {
          items: sliced,
          scripts: sliced,
          total: items.length,
        };
      },
      { ttlMs: DASHBOARD_LIST_CACHE_TTL_MS, extraKey: "scripts-by-stage-v1" }
    ).then((result) => {
      if (result?.__error) {
        return res.status(result.__error.code).json({ message: result.__error.message });
      }
    });
  } catch (err) {
    console.error("scripts-by-stage error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /scripts-by-employee
   ──────────────────────────────────────────────────────────── */
router.get("/scripts-by-employee", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { employeeName, filter: empFilter, dateFrom, dateTo } = req.query;

        const scopedEmployeeName = getScopedName(user, employeeName);
        if (!scopedEmployeeName) {
          return { __error: { code: 400, message: "employeeName required" } };
        }

        const createdRange = buildDateRange(dateFrom, dateTo);

        const items = await fetchAcrossSchemas(
          () =>
            andFilters(
              { editAssignedTo: scopedEmployeeName },
              createdRange ? { createdAt: createdRange } : {},
              empFilter === "pending"
                ? { stage: { $in: ["Edit Pending", "Cut Done"] } }
                : empFilter === "completed"
                ? {
                    $or: [
                      { editDoneAt: { $exists: true, $ne: null } },
                      { stage: "Edit Done" },
                      { stage: "Post" },
                    ],
                  }
                : empFilter === "blocked"
                ? {
                    $or: [
                      { editStatus: { $in: BLOCKED_EDIT_STATUSES } },
                      { postStatus: { $in: BLOCKED_POST_STATUSES } },
                    ],
                  }
                : {}
            ),
          (cfg) => buildSelectFields(cfg),
          "updatedAt"
        );

        const sliced = items.slice(0, 300);

        return {
          items: sliced,
          scripts: sliced,
          total: items.length,
        };
      },
      { ttlMs: DASHBOARD_LIST_CACHE_TTL_MS, extraKey: "scripts-by-employee-v1" }
    ).then((result) => {
      if (result?.__error) {
        return res.status(result.__error.code).json({ message: result.__error.message });
      }
    });
  } catch (err) {
    console.error("scripts-by-employee error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /blocked-scripts
   ──────────────────────────────────────────────────────────── */
router.get("/blocked-scripts", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { dateFrom, dateTo, employeeName } = req.query;

        const createdRange = buildDateRange(dateFrom, dateTo);

        const blockedStateFilter = {
          $or: [
            { editStatus: { $in: BLOCKED_EDIT_STATUSES } },
            { postStatus: { $in: BLOCKED_POST_STATUSES } },
          ],
        };

        let assigneeFilter = {};

        if (hasFullAccess(user)) {
          assigneeFilter = employeeName
            ? { editAssignedTo: String(employeeName).trim() }
            : {};
        } else {
          const myName = String(user.fullName || "").trim();
          assigneeFilter = myName ? { editAssignedTo: myName } : { _id: null };
        }

        const items = await fetchAcrossSchemas(
          () =>
            andFilters(
              blockedStateFilter,
              assigneeFilter,
              createdRange ? { createdAt: createdRange } : {}
            ),
          (cfg) => buildSelectFields(cfg),
          "updatedAt"
        );

        return {
          items,
          scripts: items,
          total: items.length,
        };
      },
      { ttlMs: DASHBOARD_LIST_CACHE_TTL_MS, extraKey: "blocked-scripts-v1" }
    );
  } catch (err) {
    console.error("blocked-scripts error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /scripts-by-person
   ──────────────────────────────────────────────────────────── */
router.get("/scripts-by-person", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { name, field, dateRange, customStart, customEnd, dateFrom, dateTo } = req.query;

        const allowedFields = [
          "createdBy",
          "shootDoneBy",
          "cutDoneBy",
          "cutUploadedBy",
          "editDoneBy",
          "postedBy",
        ];

        if (!field || !allowedFields.includes(field)) {
          return { __error: { code: 400, message: "valid field is required" } };
        }

        const cleanName = String(name || "").trim();
        const scopedName = getScopedName(user, cleanName);

        if (!scopedName && hasFullAccess(user)) {
          return { __error: { code: 400, message: "name and field are required" } };
        }

        const range =
          buildRangeFromPreset(dateRange, customStart, customEnd) ||
          buildDateRange(dateFrom, dateTo);

        const dateFieldMap = {
          createdBy: "createdAt",
          shootDoneBy: "shootDoneAt",
          cutDoneBy: "cutDoneAt",
          cutUploadedBy: "cutDoneAt",
          editDoneBy: "editDoneAt",
          postedBy: "postedAt",
        };

        const dateFieldKey = dateFieldMap[field] || "createdAt";

        const personFilter = hasFullAccess(user)
          ? { [field]: scopedName }
          : buildActorFilter(field, user);

        const items = await fetchAcrossSchemas(
          () =>
            andFilters(
              personFilter,
              range ? { [dateFieldKey]: range } : {}
            ),
          (cfg) => buildSelectFields(cfg),
          "createdAt"
        );

        const sliced = items.slice(0, 300);

        return {
          items: sliced,
          scripts: sliced,
          total: items.length,
        };
      },
      { ttlMs: DASHBOARD_LIST_CACHE_TTL_MS, extraKey: "scripts-by-person-v1" }
    ).then((result) => {
      if (result?.__error) {
        return res.status(result.__error.code).json({ message: result.__error.message });
      }
    });
  } catch (err) {
    console.error("scripts-by-person error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /writer-scripts
   ──────────────────────────────────────────────────────────── */
router.get("/writer-scripts", requireSession, async (req, res) => {
  try {
    await respondWithCache(
      req,
      res,
      async () => {
        const user = req.sessionUser;
        const { writerName, filter: writerFilter, dateFrom, dateTo } = req.query;

        const scopedWriterName = getScopedName(user, writerName);
        const createdRange = buildDateRange(dateFrom, dateTo);

        if (!scopedWriterName && hasFullAccess(user)) {
          return { __error: { code: 400, message: "writerName required" } };
        }

        const items = await fetchAcrossSchemas(
          (cfg) => {
            const writerBaseFilter = hasFullAccess(user)
              ? scopedWriterName
                ? { createdBy: scopedWriterName }
                : {}
              : buildActorFilter("createdBy", user);

            const reviewField = cfg.reviewStatusField;

            const stateFilter =
              writerFilter === "pendingReview"
                ? { [reviewField]: "Pending" }
                : writerFilter === "approved"
                ? { [reviewField]: "Approved" }
                : writerFilter === "rewrite"
                ? { [reviewField]: "Rewrite" }
                : writerFilter === "onHold"
                ? { [reviewField]: "On Hold" }
                : writerFilter === "rejected"
                ? { [reviewField]: "Rejected" }
                : writerFilter === "posted"
                ? {
                    $or: [
                      { postPublishStatus: { $in: PUBLISH_STATUSES } },
                      { postedAt: { $exists: true, $ne: null } },
                    ],
                  }
                : {};

            return andFilters(
              writerBaseFilter,
              createdRange ? { createdAt: createdRange } : {},
              stateFilter
            );
          },
          (cfg) => buildSelectFields(cfg),
          "createdAt"
        );

        const sliced = items.slice(0, 300);

        return {
          items: sliced,
          scripts: sliced,
          total: items.length,
        };
      },
      { ttlMs: DASHBOARD_LIST_CACHE_TTL_MS, extraKey: "writer-scripts-v1" }
    ).then((result) => {
      if (result?.__error) {
        return res.status(result.__error.code).json({ message: result.__error.message });
      }
    });
  } catch (err) {
    console.error("writer-scripts error:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;