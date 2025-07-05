const express = require('express');
const axios = require('axios');
const router = express.Router();
require('dotenv').config();

const PHONEPE_CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const PHONEPE_CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const PHONEPE_CLIENT_VERSION = process.env.PHONEPE_CLIENT_VERSION;
const OAUTH_URL = 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'; 
const PAYLINK_URL = 'https://api.phonepe.com/apis/pg/paylinks/v1/pay';

// Token memory cache
let cachedToken = null;
let cachedExpiry = null;  

// Helper to get or refresh PhonePe token
async function getPhonePeToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedExpiry && now < cachedExpiry - 60) { 
    return cachedToken;
  }

  // Prepare payload for PhonePe OAuth
  const params = new URLSearchParams();
  params.append('client_id', PHONEPE_CLIENT_ID);
  params.append('client_version', PHONEPE_CLIENT_VERSION);
  params.append('client_secret', PHONEPE_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  // Request new token
  const resp = await axios.post(OAUTH_URL, params, { headers });
  if (!resp.data.access_token || !resp.data.expires_at) {
    throw new Error('Failed to get PhonePe access token');
  }
  cachedToken = resp.data.access_token;
  cachedExpiry = resp.data.expires_at;
  console.log('Fetched new PhonePe token, expires at', cachedExpiry);
  return cachedToken;
}

// Helper to generate a unique merchant order id
function generateMerchantOrderId() {
  return 'ORDER_' + Date.now();
}

router.post('/create-payment-link', async (req, res) => {
  try {
    const {
      amount,  
      customer = {},
      metaInfo = {},
      expireAt
    } = req.body;

    if (!amount || !customer.phoneNumber) {
      console.log("Missing required parameters: amount or customer.phoneNumber");
      return res.status(400).json({ error: "Missing amount or customer phone number" });
    }

    // Validate phone number format
    if (!/^\+91\d{10}$/.test(customer.phoneNumber)) {
      console.log("Invalid phone number format: ", customer.phoneNumber);
      return res.status(400).json({ error: "Invalid phone number format. It should be +91XXXXXXXXXX" });
    }

    // Convert rupees to paise
    const amountPaise = Math.round(Number(amount) * 100);

    const merchantOrderId = generateMerchantOrderId();

    const payload = {
      merchantOrderId,
      amount: amountPaise,
      metaInfo: { ...metaInfo },
      paymentFlow: {
        type: "PAYLINK",
        customerDetails: {
          name: customer.name || "Customer",
          phoneNumber: customer.phoneNumber,
          email: customer.email || "customer@example.com"
        },
        notificationChannels: {
          SMS: false,
          EMAIL: false
        }
      }
    };

    if (expireAt) {
      payload.paymentFlow.expireAt = expireAt;
    }

    // Get valid PhonePe token (will fetch or reuse)
    const token = await getPhonePeToken();

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `O-Bearer ${token}`
    };

    // Logging outgoing request for debugging
    console.log("Sending request to PhonePe Paylink:", JSON.stringify(payload, null, 2));

    const response = await axios.post(PAYLINK_URL, payload, { headers });

    // Logging the response from PhonePe
    console.log("Received response from PhonePe:", response.status, response.data);

    if (response.status === 200 && response.data.paylinkUrl) {
      return res.json({
        paylinkUrl: response.data.paylinkUrl,
        orderId: response.data.orderId,
        expireAt: response.data.expireAt,
        state: response.data.state
      });
    } else {
      console.log("Failed to create paylink:", response.data);
      return res.status(400).json({
        error: response.data.message || "Failed to create paylink"
      });
    }
  } catch (err) {
    if (err.response && err.response.data) {
      console.log("PhonePe API error response:", err.response.status, err.response.data);
      return res.status(err.response.status).json(err.response.data);
    }
    console.log("Unhandled server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
