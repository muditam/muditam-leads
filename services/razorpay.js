const express = require("express");
const Razorpay = require("razorpay");
const router = express.Router();
 
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * POST /create-payment-link
 * Expects JSON body with:
 * {
 *   amount: <number>,         
 *   currency: "INR",
 *   customer: {
 *     name: <string>,
 *     email: <string>,
 *     contact: <string>
 *   }
 * }
 *
 * This endpoint creates a payment link for the provided amount.
 * Note: Razorpay expects the amount in the smallest currency unit (paise),
 * so we multiply the rupees amount by 100.
 * By omitting the callback_url, the user will not be redirected after payment.
 */
router.post("/create-payment-link", async (req, res) => {
  const { amount, currency, customer } = req.body;
  try {
    const options = {
      amount: amount * 100, // converting rupees to paise
      currency: currency,
      accept_partial: false,
      description: "Payment for order",
      customer: {
        name: customer.name,
        email: customer.email,
        contact: customer.contact,
      },
      notify: {
        sms: true,
        email: true,
      },
      // Do not include callback_url or callback_method
    };

    const paymentLink = await razorpay.paymentLink.create(options);
    res.json({ paymentLink: paymentLink.short_url });
  } catch (error) {
    console.error("Error generating payment link:", error);
    res.status(500).json({ message: "Error generating payment link", error: error.message });
  }
});

module.exports = router;




// const express = require("express");
// const axios = require("axios");
// const crypto = require("crypto");
// const router = express.Router();

// // PhonePe credentials (use your real values here)
// const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
// const SALT_KEY = process.env.PHONEPE_SALT_KEY;
// const SALT_INDEX = process.env.PHONEPE_SALT_INDEX;
// const BASE_URL = "https://api.phonepe.com/apis/hermes"; // production URL; for sandbox use sandbox endpoint

// router.post("/create-payment-link", async (req, res) => {
//   const { amount, currency, customer } = req.body;

//   try {
//     const payRequest = {
//       merchantId: MERCHANT_ID,
//       merchantTransactionId: `txn_${Date.now()}`,
//       merchantUserId: `user_${Date.now()}`,
//       amount: Math.round(amount * 100), // converting rupees to paise
//       redirectUrl: "https://your-success-page.com",
//       redirectMode: "REDIRECT",
//       callbackUrl: "https://your-callback-url.com",
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
//       "X-VERIFY": checksum
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
//     console.error("Error generating PhonePe payment link:", error.response?.data || error.message);
//     res.status(500).json({
//       message: "Error generating PhonePe payment link",
//       error: error.response?.data || error.message
//     });
//   }
// });

// module.exports = router;




