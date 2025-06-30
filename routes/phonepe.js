// const express = require('express');
// const axios = require('axios');
// const router = express.Router();

// // Load env variables
// const {
//   PHONEPE_CLIENT_ID,
//   PHONEPE_CLIENT_SECRET,
//   NODE_ENV
// } = process.env;

// if (!PHONEPE_CLIENT_ID || !PHONEPE_CLIENT_SECRET) {
//   console.error("Missing PhonePe client credentials in environment variables");
// }

// const isProduction = NODE_ENV === 'production';

// const TOKEN_URL = isProduction
//   ? 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token'
//   : 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';

// const PAYLINK_URL = isProduction
//   ? 'https://api.phonepe.com/apis/pg/paylinks/v1/pay'
//   : 'https://api-preprod.phonepe.com/apis/pg-sandbox/paylinks/v1/pay';

// let cachedToken = null; 
// let tokenExpiry = 0;

// console.log(`Using ${isProduction ? 'PRODUCTION' : 'SANDBOX'} environment`);

// async function fetchAccessToken() {
//   if (cachedToken && Date.now() < tokenExpiry) {
//     console.log("Reusing cached token");
//     return cachedToken;
//   }

//   console.log("Fetching new PhonePe token...");

//   const data = isProduction
//     ? `client_id=${PHONEPE_CLIENT_ID}&client_secret=${PHONEPE_CLIENT_SECRET}&grant_type=client_credentials&client_version=PROD`
//     : new URLSearchParams({
//         client_id: PHONEPE_CLIENT_ID,
//         client_secret: PHONEPE_CLIENT_SECRET,
//         grant_type: 'client_credentials',
//         client_version: '1',
//       });

//   try {
//     const res = await axios.post(TOKEN_URL, data, {
//       headers: {
//         'Content-Type': 'application/x-www-form-urlencoded',
//       },
//     });

//     console.log("Token fetch response:", res.data);

//     const tokenData = res.data?.data;
//     if (!tokenData || !tokenData.access_token) {
//       throw new Error("Token missing in response");
//     }

//     cachedToken = tokenData.access_token;
//     tokenExpiry = tokenData.expires_at * 1000;
//     return cachedToken;

//   } catch (error) {
//     console.error("Token fetch failed");
//     if (error.response) {
//       console.error("Response Status:", error.response.status); 
//       console.error("Response Body:", error.response.data);
//     } else {
//       console.error("Error Message:", error.message);
//     }
//     throw new Error("Failed to fetch access token");
//   }
// }


// router.post('/create-payment-link', async (req, res) => {
//   try {
//     const token = await fetchAccessToken();

//     const { amount, name, phone, email } = req.body;

//     if (!amount || !phone || !name) {
//       console.warn("Missing required fields in request body", req.body);
//       return res.status(400).json({ error: 'Missing required fields: amount, name, phone' });
//     }

//     const merchantOrderId = `ORD-${Date.now()}`;
//     const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

//     const payload = {
//       merchantOrderId,
//       amount: Math.floor(amount * 100), // convert to paise
//       paymentFlow: {
//         type: 'PAYLINK',
//         customerDetails: {
//           name,
//           phoneNumber: phone.startsWith('+91') ? phone : `+91${phone}`,
//           email,
//           notificationChannels: {
//             SMS: true,
//             EMAIL: true,
//           },
//         },
//         expireAt,
//       },
//     };

//     console.log("Sending Paylink payload to PhonePe:", JSON.stringify(payload, null, 2));

//     const response = await axios.post(PAYLINK_URL, payload, {
//       headers: {
//         'Content-Type': 'application/json',
//         Authorization: `O-Bearer ${token}`,
//       },
//     });

//     console.log("PhonePe paylink response:", response.data);

//     const data = response.data?.data;
//     if (!data || !data.paylinkUrl) {
//       console.error("Invalid PhonePe response:", response.data);
//       return res.status(500).json({ error: 'Failed to generate paylink' });
//     }

//     return res.json({
//       paylinkUrl: data.paylinkUrl,
//       orderId: data.orderId,
//       expireAt: data.expireAt,
//     });

//   } catch (error) {
//     console.error('PhonePe Payment Link Error');

//     if (error.response) {
//       console.error("Status Code:", error.response.status);
//       console.error("Response Body:", JSON.stringify(error.response.data, null, 2));
//     } else {
//       console.error("Message:", error.message);
//     }

//     return res.status(500).json({
//       error: 'Failed to create PhonePe payment link',
//       details: error.response?.data || error.message,
//     });
//   }
// });

// module.exports = router;
