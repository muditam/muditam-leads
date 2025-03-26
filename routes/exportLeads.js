const express = require('express');
const router = express.Router();
const { format } = require('@fast-csv/format');
const Lead = require('../models/Lead'); 

// CSV Export Endpoint
router.get('/export-leads', async (req, res) => {
  // Set headers for CSV download
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads_data.csv"');

  // Create a CSV stream using fast-csv with headers enabled
  const csvStream = format({ headers: true });
  csvStream.pipe(res);
 
  try { 
    const cursor = Lead.find().sort({ _id: -1 }).cursor();
    cursor.on('data', (doc) => { 
      csvStream.write(doc.toObject());
    });
    cursor.on('end', () => {
      csvStream.end();
    });
    cursor.on('error', (error) => {
      console.error('Error streaming leads:', error);
      res.status(500).end();
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
