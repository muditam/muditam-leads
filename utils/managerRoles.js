const MANAGER_ROLES = new Set([
  "manager",
  "super admin",
  "admin",
  "developer",
  "team leader",
  "teamleader",
]);

function normalizeRole(role = "") {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function isManagerRole(role = "") {
  return MANAGER_ROLES.has(normalizeRole(role));
}

module.exports = {
  MANAGER_ROLES,
  normalizeRole,
  isManagerRole,
};
