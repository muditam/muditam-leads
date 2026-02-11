const express = require('express');
const router = express.Router();
const Order = require('../models/Order');


const EXCLUDED_STATUSES = ['Delivered', 'RTO Delivered'];


// ✅ NEW: PATCH endpoint to update opsRemark and assignedAgentId
router.patch('/ops-meta/by-order-id', async (req, res) => {
  try {
    const { order_id, opsRemark, assignedAgentId } = req.body;


    if (!order_id) {
      return res.status(400).json({ message: 'order_id is required' });
    }


    // Build update object
    const updateData = {
      last_updated_at: new Date(),
    };


    // Handle opsRemark (can be empty string to clear)
    if (opsRemark !== undefined) {
      updateData.opsRemark = opsRemark.trim();
    }


    // Handle assignedAgentId (can be null to clear)
    if (assignedAgentId !== undefined) {
      updateData.assignedAgentId = assignedAgentId || null;
    }


    const updatedOrder = await Order.findOneAndUpdate(
      { order_id },
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('order_id opsRemark assignedAgentId last_updated_at');


    if (!updatedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }


    res.json({
      success: true,
      order: updatedOrder,
      message: 'Ops metadata updated successfully'
    });
  } catch (err) {
    console.error('Error updating ops metadata:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


// ✅ IMPROVED: GET endpoint with server-side filtering
router.get('/undelivered-orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
   
    const statusFilter = req.query.status;
    const carrierFilter = req.query.carrier;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const viewTab = req.query.viewTab; // 'pending' or 'processed'
    const selectedAgent = req.query.selectedAgent;


    // Base filter - exclude delivered orders
    const filter = {
      shipment_status: { $nin: EXCLUDED_STATUSES },
    };


    // ✅ FIX: Apply date filter to prevent yesterday's data appearing
    if (startDate || endDate) {
      filter.order_date = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        filter.order_date.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.order_date.$lte = end;
      }
    }


    // Status filter
    if (statusFilter && !EXCLUDED_STATUSES.includes(statusFilter)) {
      filter.shipment_status = statusFilter;
    }


    // Carrier filter
    if (carrierFilter) {
      filter.carrier_title = carrierFilter;
    }


    // ✅ FIX: Server-side filtering for viewTab (Pending vs Processed)
    if (viewTab === 'pending') {
      // Pending = no opsRemark or empty opsRemark
      filter.$or = [
        { opsRemark: { $exists: false } },
        { opsRemark: '' },
        { opsRemark: null }
      ];
    } else if (viewTab === 'processed') {
      // Processed = has opsRemark (non-empty)
      filter.opsRemark = { $exists: true, $ne: '', $ne: null };


      // ✅ FIX: Agent filter (only in processed tab)
      if (selectedAgent) {
        if (selectedAgent === 'unassigned') {
          filter.$or = [
            { assignedAgentId: { $exists: false } },
            { assignedAgentId: null }
          ];
        } else {
          filter.assignedAgentId = selectedAgent;
        }
      }
    }


    // Fetch orders with proper sorting
    const orders = await Order.find(filter)
      .select('order_id contact_number full_name shipment_status order_date tracking_number carrier_title opsRemark assignedAgentId last_updated_at')
      .sort({ last_updated_at: -1, order_date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();


    // ✅ FIX: Count only filtered results
    const totalCount = await Order.countDocuments(filter);


    // Get status counts (for filter chips) - without viewTab filter
    const statusFilter_base = {
      shipment_status: { $nin: EXCLUDED_STATUSES },
    };


    if (startDate || endDate) {
      statusFilter_base.order_date = filter.order_date;
    }
    if (carrierFilter) {
      statusFilter_base.carrier_title = carrierFilter;
    }


    const statusCounts = await Order.aggregate([
      { $match: statusFilter_base },
      {
        $group: {
          _id: "$shipment_status",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          shipment_status: "$_id",
          count: 1,
          _id: 0
        }
      },
      { $sort: { count: -1 } }
    ]);


    // Get distinct carriers
    const carrierList = await Order.distinct("carrier_title", statusFilter_base);


    res.json({
      orders,
      totalCount,
      statusCounts,
      carriers: carrierList.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


module.exports = router;

