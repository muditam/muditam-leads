const express = require("express");
const router = express.Router();
const axios = require("axios");
const { google } = require("googleapis");
const path = require("path");

// --------------------------------------------------
// ENV CONFIG
// --------------------------------------------------
const SHOPIFY_STORE = `${process.env.SHOPIFY_STORE_NAME}.myshopify.com`;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const PHONE_SHEET_ID = process.env.PHONE_SHEET_ID;
const EMAIL_SHEET_ID = process.env.EMAIL_SHEET_ID;

const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// --------------------------------------------------
// VALIDATION (FAIL FAST)
// --------------------------------------------------
if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
  console.error("❌ Missing Shopify env variables");
}

if (!GOOGLE_KEYFILE) {
  console.error("❌ GOOGLE_APPLICATION_CREDENTIALS missing");
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------
function normalizePhone(phone = "") {
  const d = String(phone).replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(GOOGLE_KEYFILE), // ✅ FIXED
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function getLastOrderId(sheets, sheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "B2"
    });

    return res.data.values?.[0]?.[0]
      ? Number(res.data.values[0][0])
      : 0;
  } catch {
    return 0;
  }
}

async function setLastOrderId(sheets, sheetId, orderId) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "B2",
    valueInputOption: "RAW",
    resource: { values: [[orderId]] }
  });
}

async function appendColumn(sheets, sheetId, values) {
  if (!values.length) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "A:A",
    valueInputOption: "RAW",
    resource: {
      values: values.map(v => [v])
    }
  });
}

// --------------------------------------------------
// 📞 EXPORT PHONES API
// --------------------------------------------------
router.get("/export-order-phones", async (req, res) => {
  try {
    if (!PHONE_SHEET_ID) {
      throw new Error("PHONE_SHEET_ID is missing in env");
    }

    const sheets = await getSheetsClient();
    let sinceId = await getLastOrderId(sheets, PHONE_SHEET_ID);

    let maxOrderId = sinceId;
    const phoneSet = new Set();

    let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=250&status=any&since_id=${sinceId}`;

    while (url) {
      const response = await axios.get(url, {
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN }
      });

      const orders = response.data.orders || [];

      orders.forEach(order => {
        maxOrderId = Math.max(maxOrderId, order.id);

        const phone =
          order.phone ||
          order.shipping_address?.phone ||
          order.billing_address?.phone ||
          "";

        const normalized = normalizePhone(phone);
        if (normalized) phoneSet.add(normalized);
      });

      const link = response.headers["link"];
      const match = link?.match(/<(.*)>; rel="next"/);
      url = match ? match[1] : null;
    }

    if (phoneSet.size === 0) {
      return res.json({
        success: true,
        message: "No new phone data found"
      });
    }

    await appendColumn(sheets, PHONE_SHEET_ID, [...phoneSet]);
    await setLastOrderId(sheets, PHONE_SHEET_ID, maxOrderId);

    res.json({
      success: true,
      newPhones: phoneSet.size,
      lastOrderId: maxOrderId
    });

  } catch (err) {
    console.error("PHONE EXPORT ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------
// 📧 EXPORT EMAILS API
// --------------------------------------------------
router.get("/export-order-emails", async (req, res) => {
  try {
    if (!EMAIL_SHEET_ID) {
      throw new Error("EMAIL_SHEET_ID is missing in env");
    }

    const sheets = await getSheetsClient();
    let sinceId = await getLastOrderId(sheets, EMAIL_SHEET_ID);

    let maxOrderId = sinceId;
    const emailSet = new Set();

    let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?limit=250&status=any&since_id=${sinceId}`;

    while (url) {
      const response = await axios.get(url, {
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN }
      });

      const orders = response.data.orders || [];

      orders.forEach(order => {
        maxOrderId = Math.max(maxOrderId, order.id);
        if (order.email) emailSet.add(order.email.trim());
      });

      const link = response.headers["link"];
      const match = link?.match(/<(.*)>; rel="next"/);
      url = match ? match[1] : null;
    }

    if (emailSet.size === 0) {
      return res.json({
        success: true,
        message: "No new email data found"
      });
    }

    await appendColumn(sheets, EMAIL_SHEET_ID, [...emailSet]);
    await setLastOrderId(sheets, EMAIL_SHEET_ID, maxOrderId);

    res.json({
      success: true,
      newEmails: emailSet.size,
      lastOrderId: maxOrderId
    });

  } catch (err) {
    console.error("EMAIL EXPORT ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
