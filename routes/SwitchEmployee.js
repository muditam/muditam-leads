// routes/employeeRoutes.js
const express = require('express');
const Employee = require('../models/Employee');


const router = express.Router();


// ✅ Define the super-admin roles ONCE (add/remove titles you use)
const SUPER_ADMIN_ROLES = new Set(['admin', 'super admin', 'manager']);


// ✅ Single helper used everywhere
const isSuperAdmin = (role = '') =>
 SUPER_ADMIN_ROLES.has(String(role).toLowerCase());


// 🔍 Search employees (used by SwitchDashboard)
router.get('/', async (req, res) => {
 try {
   const { search = '', actorRole, actorDepartment } = req.query;
   const trimmed = String(search || '').trim();


   const superAdmin = isSuperAdmin(actorRole);


   // Keep role-first compatibility; use department only as fallback.
   const scopedFilter = !superAdmin
     ? actorRole
       ? { role: actorRole }
       : actorDepartment
         ? { department: actorDepartment }
         : {}
     : {};


   if (trimmed.length >= 2) {
     const regex = new RegExp(trimmed, 'i');


     const results = await Employee.find({
       ...scopedFilter,
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
   const baseQuery = { status: 'active', ...scopedFilter };


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


   const { employeeId, actorRole, actorDepartment } = req.body || {};
   if (!employeeId) {
     return res.status(400).json({ message: 'employeeId is required' });
   }


   const target = await Employee.findById(employeeId)
     .select(
       '_id fullName email role department hasTeam callerId agentNumber orderConfirmActive permissions'
     )
     .lean();


   if (!target) {
     return res.status(404).json({ message: 'Employee not found' });
   }


   const superAdmin = isSuperAdmin(actorRole);


   // Keep role-first compatibility; use department only as fallback.
   const roleBasedBlocked =
     !superAdmin && actorRole && target.role !== actorRole;
   const departmentBasedBlocked =
     !superAdmin &&
     !actorRole &&
     actorDepartment &&
     String(target.department || '').toLowerCase() !==
       String(actorDepartment || '').toLowerCase();


   if (roleBasedBlocked || departmentBasedBlocked) {
     return res
       .status(403)
       .json({ message: 'You can only switch within your department.' });
   }


   // Save original user once
   if (!req.session.originalUserId) {
     req.session.originalUserId = req.session.userId || null;
   }


   req.session.userId = target._id.toString();
   req.session.save((saveErr) => {
     if (saveErr) {
       console.error('Session save error (impersonate):', saveErr);
       return res.status(500).json({ message: 'Failed to update session' });
     }


     return res.json({
       user: {
         id: target._id,
         fullName: target.fullName,
         email: target.email,
         role: target.role,
         department: target.department || '',
         hasTeam: !!target.hasTeam,
         callerId: target.callerId,
         agentNumber: target.agentNumber,
         orderConfirmActive: target.orderConfirmActive,
         // ✅ pass permissions to frontend on switch
         permissions: target.permissions || { menubar: {}, navbar: {} },
       },
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


   req.session.userId = original._id.toString();
   req.session.originalUserId = null;


   req.session.save((saveErr) => {
     if (saveErr) {
       console.error('Session save error (revert):', saveErr);
       return res.status(500).json({ message: 'Failed to restore session' });
     }


     return res.json({
       user: {
         id: original._id,
         fullName: original.fullName,
         email: original.email,
         role: original.role,
         department: original.department || '',
         hasTeam: !!original.hasTeam,
         callerId: original.callerId,
         agentNumber: original.agentNumber,
         orderConfirmActive: original.orderConfirmActive,
         // ✅ also restore original user's permissions
         permissions: original.permissions || { menubar: {}, navbar: {} },
       },
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



