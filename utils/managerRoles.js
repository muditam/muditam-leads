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

function canAccessCallingCenterManagerDashboard(user = {}) {
  const normalizedRole = normalizeRole(user?.role || "");
  const hasTeam = user?.hasTeam === true;

  if (isManagerRole(normalizedRole)) return true;
  if (normalizedRole === "team leader" && hasTeam) return true;
  if (normalizedRole === "retention agent" && hasTeam) return true;

  return false;
}

module.exports = {
  MANAGER_ROLES,
  normalizeRole,
  isManagerRole,
  canAccessCallingCenterManagerDashboard,
};
