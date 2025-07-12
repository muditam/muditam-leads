// routes/download.js

const express = require('express');
const router = express.Router();
const MyOrder = require('../models/MyOrder');
const { Parser } = require('json2csv');

router.get('/', async (req, res) => {
  try {
    const orders = await MyOrder.find().lean();
    if (!orders.length) return res.status(404).send('No data found');

    const fields = [
      'customerName', 'phone', 'shippingAddress', 'paymentStatus',
      'productOrdered', 'orderDate', 'orderId', 'totalPrice', 'agentName',
      'partialPayment', 'dosageOrdered', 'selfRemark', 'paymentMethod', 'upsellAmount'
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(orders);

    res.header('Content-Type', 'text/csv');
    res.attachment('myorders.csv');
    return res.send(csv);
  } catch (err) {
    console.error('CSV download error:', err);
    res.status(500).send('Error generating CSV');
  }
});

module.exports = router;
