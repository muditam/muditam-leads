// // routes/phonepe.js
// const express = require("express");
// const axios = require("axios");
// const crypto = require("crypto");
// const router = express.Router();

// // ENV-based credentials (use a .env file or cloud env variables)
// const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || "MUDITAMUAT";
// const SALT_KEY = process.env.PHONEPE_SALT_KEY || "NTA3NTk4NTMtZDNmYy00NGVmLTgzZjgtYmIxNjljMjk2ZGUz";
// const SALT_INDEX = process.env.PHONEPE_SALT_INDEX || "1";
// const BASE_URL = process.env.PHONEPE_BASE_URL || "https://api-preprod.phonepe.com/apis/pg-sandbox";

// router.post("/create-payment-link", async (req, res) => {
//   const { amount, currency, customer } = req.body;

//   try {
//     const payRequest = {
//       merchantId: MERCHANT_ID,
//       merchantTransactionId: `txn_${Date.now()}`,
//       merchantUserId: `user_${Date.now()}`,
//       amount: Math.round(amount * 100), // in paise
//       redirectUrl: "https://60brands.com/order-success",
//       redirectMode: "REDIRECT",
//       callbackUrl: "https://muditamleads-14f32a10d7f7.herokuapp.com/api/phonepe/webhook", 
//       mobileNumber: customer.contact,
//       paymentInstrument: {
//         type: "PAY_PAGE"
//       }
//     };

//     const payloadBase64 = Buffer.from(JSON.stringify(payRequest)).toString("base64");
//     const stringToSign = `${payloadBase64}/pg/v1/pay${SALT_KEY}`;
//     const checksum = crypto.createHash("sha256").update(stringToSign).digest("hex") + `###${SALT_INDEX}`;

//     const headers = {
//       "Content-Type": "application/json",
//       "X-VERIFY": checksum,
//       "X-CLIENT-ID": process.env.PHONEPE_CLIENT_ID || "MUDITAMUAT_2506121619554",
//     };

//     const response = await axios.post(`${BASE_URL}/pg/v1/pay`, {
//       request: payloadBase64
//     }, { headers });

//     if (response.data.success) {
//       const paymentUrl = response.data.data.instrumentResponse.redirectInfo.url;
//       res.json({ paymentLink: paymentUrl });
//     } else {
//       res.status(400).json({ message: "Failed to generate PhonePe payment link", error: response.data });
//     }

//   } catch (error) { 
//   console.error("=== PhonePe ERROR ===");
//   console.error("Full error:", error?.response?.data || error.message);
//   console.error("Request sent:", {
//     payRequest,
//     payloadBase64,
//     checksum,
//     headers
//   });
//     res.status(500).json({
//       message: "Error generating PhonePe payment link",
//       error: error.response?.data || error.message
//     });
//   }
// });

// module.exports = router;
