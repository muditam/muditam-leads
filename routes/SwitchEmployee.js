// routes/employeeRoutes.js
const express = require('express');
const Employee = require('../models/Employee');


const router = express.Router();


const SUPER_ADMIN_ROLES = new Set(['super admin', 'super-admin', 'superadmin']);
const MANAGER_ROLES = new Set(['manager']);
const TEAM_LEADER_ROLES = new Set(['team leader', 'team-leader', 'teamleader']);
const ASSISTANT_TEAM_LEADER_ROLES = new Set([
  'assistant team lead',
  'assistant team leader',
  'assistant-team-lead',
  'assistant-team-leader',
]);
const MANAGER_ALLOWED_TARGET_ROLES = new Set([
  'team leader',
  'team-leader',
  'teamleader',
  'assistant team lead',
  'assistant team leader',
  'assistant-team-lead',
  'assistant-team-leader',
  'retention agent',
  'sales agent',
]);


const normalizeRole = (role = '') => String(role || '').trim().toLowerCase();
const toId = (value) => (value ? String(value) : '');
const isSuperAdmin = (role = '') => SUPER_ADMIN_ROLES.has(normalizeRole(role));
const isManager = (role = '') => MANAGER_ROLES.has(normalizeRole(role));
const isTeamLeader = (role = '') => TEAM_LEADER_ROLES.has(normalizeRole(role));
const isAssistantTeamLeaderRole = (role = '') =>
  ASSISTANT_TEAM_LEADER_ROLES.has(normalizeRole(role));
const isRetentionAgentRole = (role = '') => normalizeRole(role) === 'retention agent';
const isManagerRole = (role = '') => normalizeRole(role) === 'manager';
const isTeamLeaderRole = (role = '') => TEAM_LEADER_ROLES.has(normalizeRole(role));

const contactAdminError = () => ({
  kind: 'forbidden',
  message: 'contact admin for permissions',
});

async function getActorEmployee(req) {
  const sessionUser = req.session?.user || null;
  const actorId = toId(sessionUser?.id || sessionUser?._id);
  const actorEmail = String(sessionUser?.email || '').trim();

  if (!actorId && !actorEmail) return null;

  const actor = await Employee.findOne(
    actorId ? { _id: actorId } : { email: actorEmail }
  )
    .select(
      '_id fullName email role department hasTeam teamMembers teamLeader permissions callerId agentNumber orderConfirmActive'
    )
    .lean();

  return actor || null;
}

function buildSessionUser(employee = {}) {
  return {
    id: toId(employee._id),
    email: employee.email || '',
    fullName: employee.fullName || '',
    role: employee.role || '',
    department: employee.department || '',
  };
}

function buildSwitchResponseUser(employee = {}) {
  return {
    id: employee._id,
    fullName: employee.fullName,
    email: employee.email,
    role: employee.role,
    department: employee.department || '',
    hasTeam: !!employee.hasTeam,
    callerId: employee.callerId,
    agentNumber: employee.agentNumber,
    orderConfirmActive: employee.orderConfirmActive,
    permissions: employee.permissions || { menubar: {}, navbar: {} },
  };
}

function collectDescendantIds(allEmployees = [], actorId = '') {
  const byLeader = new Map();
  const byOwner = new Map();

  for (const emp of allEmployees) {
    const empId = toId(emp?._id);
    if (!empId) continue;

    const leaderId = toId(emp?.teamLeader);
    if (leaderId) {
      if (!byLeader.has(leaderId)) byLeader.set(leaderId, []);
      byLeader.get(leaderId).push(empId);
    }

    const members = Array.isArray(emp?.teamMembers) ? emp.teamMembers.map(toId).filter(Boolean) : [];
    if (members.length) byOwner.set(empId, members);
  }

  const queue = [actorId];
  const visited = new Set([actorId]);
  const descendants = new Set();

  while (queue.length) {
    const current = queue.shift();
    const edges = [...(byLeader.get(current) || []), ...(byOwner.get(current) || [])];

    for (const nextId of edges) {
      if (!nextId || visited.has(nextId)) continue;
      visited.add(nextId);
      descendants.add(nextId);
      queue.push(nextId);
    }
  }

  return descendants;
}

async function getSwitchScope(actor) {
  const actorRole = normalizeRole(actor?.role);
  if (isSuperAdmin(actorRole)) {
    return { kind: 'all' };
  }

  if (isManager(actorRole)) {
    const targets = await Employee.find({ status: 'active' })
      .select('_id role')
      .lean();

    const ids = targets
      .filter((t) => MANAGER_ALLOWED_TARGET_ROLES.has(normalizeRole(t?.role)))
      .map((t) => toId(t?._id))
      .filter(Boolean);

    return { kind: 'ids', ids: new Set(ids) };
  }

  const assistantTeamLeaderLike =
    isAssistantTeamLeaderRole(actorRole) ||
    (isRetentionAgentRole(actorRole) && actor?.hasTeam === true);

  if (isTeamLeader(actorRole) || assistantTeamLeaderLike) {
    const actorId = toId(actor?._id);
    if (!actorId) return contactAdminError();

    const allActiveEmployees = await Employee.find({ status: 'active' })
      .select('_id role teamLeader teamMembers')
      .lean();
    const rawIds = collectDescendantIds(allActiveEmployees, actorId);
    const byId = new Map(
      allActiveEmployees
        .map((emp) => [toId(emp?._id), emp])
        .filter(([id]) => Boolean(id))
    );
    const ids = new Set(
      Array.from(rawIds).filter((id) => {
        const emp = byId.get(id);
        const role = emp?.role;
        // Explicit guard: Team Leaders/Assistant Team Leaders cannot switch to
        // managers or team leaders.
        return !isManagerRole(role) && !isTeamLeaderRole(role);
      })
    );

    return { kind: 'ids', ids };
  }

  return contactAdminError();
}


// 🔍 Search employees (used by SwitchDashboard)
router.get('/', async (req, res) => {
 try {
   if (!req.session?.user) {
     return res.status(401).json({ message: 'Unauthorized' });
   }

   const { search = '' } = req.query;
   const trimmed = String(search || '').trim();
   const actor = await getActorEmployee(req);

   if (!actor) {
     return res.status(401).json({ message: 'Unauthorized' });
   }

   const scope = await getSwitchScope(actor);
   const baseFilter = { status: 'active' };
   const actorId = toId(actor._id);

   if (scope.kind === 'forbidden') {
     return res.status(403).json({ message: scope.message || 'contact admin for permissions' });
   }

   if (scope.kind === 'ids') {
     const allowedIds = Array.from(scope.ids || []);
     if (!allowedIds.length) return res.json([]);
     baseFilter._id = { $in: allowedIds };
   }


   if (trimmed.length >= 2) {
     const regex = new RegExp(trimmed, 'i');


     const results = await Employee.find({
       ...baseFilter,
       _id: { ...(baseFilter._id || {}), $ne: actorId },
       $or: [{ fullName: regex }, { email: regex }, { role: regex }, { department: regex }],
     })
       .select(
         'fullName email role department status hasTeam callerId agentNumber orderConfirmActive'
       )
       .limit(20)
       .lean();


     return res.json(results);
   }


   // default list if no / short search
   const baseQuery = { ...baseFilter, _id: { ...(baseFilter._id || {}), $ne: actorId } };


   const employees = await Employee.find(baseQuery)
     .select(
       'fullName email role department status hasTeam callerId agentNumber orderConfirmActive'
     )
     .lean();


   res.json(employees);
 } catch (err) {
   console.error('Employee fetch error:', err);
   res.status(500).json({ message: 'Unable to fetch employees' });
 }
});


// 👤 Impersonate employee (switch dashboard)
router.post('/impersonate', async (req, res) => {
 try {
   if (!req.session) {
     return res
       .status(500)
       .json({ message: 'Session middleware not configured' });
   }


   if (!req.session.user) {
     return res.status(401).json({ message: 'Unauthorized' });
   }

   const { employeeId } = req.body || {};
   if (!employeeId) {
     return res.status(400).json({ message: 'employeeId is required' });
   }


   const actor = await getActorEmployee(req);
   if (!actor) {
     return res.status(401).json({ message: 'Unauthorized' });
   }

   const target = await Employee.findById(employeeId)
     .select(
       '_id fullName email role department hasTeam callerId agentNumber orderConfirmActive permissions status'
     )
     .lean();


   if (!target) {
     return res.status(404).json({ message: 'Employee not found' });
   }

   if (String(target.status || '').toLowerCase() !== 'active') {
     return res.status(403).json({ message: 'You can only switch to active employees.' });
   }

   const scope = await getSwitchScope(actor);
   if (scope.kind === 'forbidden') {
     return res.status(403).json({ message: scope.message || 'contact admin for permissions' });
   }
   const canAccess =
     scope.kind === 'all' ||
     (scope.kind === 'ids' && scope.ids && scope.ids.has(toId(target._id)));

   if (!canAccess) {
     return res
       .status(403)
       .json({ message: 'You can only switch within your allowed team.' });
   }


   // Save original user once
   if (!req.session.originalUserId) {
     req.session.originalUserId = toId(req.session.user?.id || req.session.user?._id) || null;
   }


   req.session.user = buildSessionUser(target);
   req.session.userId = toId(target._id);
   req.session.save((saveErr) => {
     if (saveErr) {
       console.error('Session save error (impersonate):', saveErr);
       return res.status(500).json({ message: 'Failed to update session' });
     }


     return res.json({
       user: buildSwitchResponseUser(target),
     });
   });
 } catch (err) {
   console.error('Impersonate error:', err);
   res.status(500).json({ message: 'Unable to switch dashboard' });
 }
});


// 🔙 Revert impersonation
router.post('/revert', async (req, res) => {
 try {
   if (!req.session) {
     return res
       .status(500)
       .json({ message: 'Session middleware not configured' });
   }


   const originalId = req.session.originalUserId;
   if (!originalId) {
     return res.status(400).json({ message: 'No impersonation session found' });
   }


   const original = await Employee.findById(originalId)
     .select(
       '_id fullName email role department hasTeam callerId agentNumber orderConfirmActive permissions'
     )
     .lean();


   if (!original) {
     return res.status(404).json({ message: 'Original user not found' });
   }


   req.session.user = buildSessionUser(original);
   req.session.userId = toId(original._id);
   req.session.originalUserId = null;


   req.session.save((saveErr) => {
     if (saveErr) {
       console.error('Session save error (revert):', saveErr);
       return res.status(500).json({ message: 'Failed to restore session' });
     }


     return res.json({
       user: buildSwitchResponseUser(original),
     });
   });
 } catch (err) {
   console.error('Revert error:', err);
   res.status(500).json({ message: 'Unable to revert impersonation' });
 }
});


// keep your monthly-sales route as-is
router.put('/:id/monthly-sales', async (req, res) => {
 try {
   const { monthlyDeliveredSales } = req.body || {};
   if (!monthlyDeliveredSales || typeof monthlyDeliveredSales !== 'object') {
     return res
       .status(400)
       .json({ message: 'monthlyDeliveredSales is required' });
   }
   const totalDeliveredSales = Object.values(monthlyDeliveredSales).reduce(
     (sum, val) => sum + Number(val || 0),
     0
   );


   const updated = await Employee.findByIdAndUpdate(
     req.params.id,
     { monthlyDeliveredSales, totalDeliveredSales },
     { new: true }
   );


   if (!updated) {
     return res.status(404).json({ message: 'Employee not found' });
   }


   res.json(updated);
 } catch (error) {
   console.error('Update error:', error);
   res.status(500).json({ message: 'Failed to update employee sales' });
 }
});


module.exports = router;
