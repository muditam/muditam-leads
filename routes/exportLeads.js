const express = require('express'); 
const router = express.Router(); 
const { format } = require('@fast-csv/format');  
const Lead = require('../models/Lead');

// Adjust this array to include EVERY FIELD you want!
const HEADERS = [
  "date", "time", "name", "contactNumber", "leadSource", "enquiryFor",
  "customerType", "agentAssigned", "productPitched", "leadStatus", "salesStatus",
  "nextFollowup", "calculateReminder", "agentsRemarks", "productsOrdered", "dosageOrdered",
  "amountPaid", "modeOfPayment", "deliveryStatus", "healthExpertAssigned", "orderId",
  "dosageExpiring", "rtNextFollowupDate", "rtFollowupReminder", "rtFollowupStatus",
  "lastOrderDate", "repeatDosageOrdered", "retentionStatus", "communicationMethod",
  "preferredLanguage", "rtRemark", "rowColor", "images", "rtSubcells", "details",
  "followUps", "reachoutLogs", "_id", "__v"
];

router.get('/export-leads', async (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads_data.csv"');

  const csvStream = format({ headers: HEADERS });
  csvStream.pipe(res);

  try {
    const cursor = Lead.find().sort({ _id: -1 }).cursor();
    cursor.on('data', (doc) => {
      // Ensure ALL headers are written for every row
      const lead = doc.toObject();

      // Stringify objects/arrays for easier CSV reading
      const outputRow = {};
      for (const field of HEADERS) {
        if (
          Array.isArray(lead[field]) ||
          (typeof lead[field] === 'object' && lead[field] !== null)
        ) {
          outputRow[field] = JSON.stringify(lead[field]);
        } else {
          outputRow[field] = lead[field] !== undefined ? lead[field] : "";
        }
      }
      csvStream.write(outputRow);
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
