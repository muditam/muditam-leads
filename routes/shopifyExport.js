const express = require("express");
const router = express.Router();
const axios = require("axios");
const { google } = require("googleapis");

// ENV
const SHOPIFY_STORE = `${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;

router.get("/export-clean-customers", async (req, res) => {
  try {
    let allPhones = [];
    let allEmails = [];

    let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/customers.json?limit=250`;

    // --------------------------
    // FETCH ALL CUSTOMERS
    // --------------------------
    while (url) {
      const response = await axios.get(url, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        }
      });

      const customers = response.data.customers || [];

      // extract phones & emails without mapping
      customers.forEach(c => {
        const phone = c.phone || c.default_address?.phone || "";
        const email = c.email || "";

        if (phone && phone.trim() !== "") allPhones.push(phone.trim());
        if (email && email.trim() !== "") allEmails.push(email.trim());
      });

      // pagination
      const linkHeader = response.headers["link"];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<(.*)>; rel="next"/);
        url = match ? match[1] : null;
      } else {
        url = null;
      }
    }

    // --------------------------
    // GOOGLE AUTH
    // --------------------------
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEYFILE,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });

    // Prepare rows: phones in col A, emails in col B
    const maxLen = Math.max(allPhones.length, allEmails.length);
    const rows = [];

    for (let i = 0; i < maxLen; i++) {
      rows.push([
        allPhones[i] || "",  // phone
        allEmails[i] || ""   // email
      ]);
    }

    // --------------------------
    // WRITE TO GOOGLE SHEET
    // --------------------------
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      resource: {
        values: [
          ["Phone Numbers", "Emails"],
          ...rows
        ]
      }
    });

    return res.json({
      success: true,
      phones: allPhones.length,
      emails: allEmails.length,
      message: "Clean customer list exported successfully."
    });

  } catch (err) {
    console.error("EXPORT ERROR:", err);
    return res.status(500).json({ error: "Failed to export clean list" });
  }
});

module.exports = router;
