const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const router = express.Router();

// PhonePe credentials (use your real values here)
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX;
const BASE_URL = "https://api.phonepe.com/apis/hermes";  

router.post("/create-payment-link", async (req, res) => {
  const { amount, currency, customer } = req.body;

  try {
    const payRequest = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: `txn_${Date.now()}`,
      merchantUserId: `user_${Date.now()}`,
      amount: Math.round(amount * 100), 
      redirectUrl: "https://your-success-page.com",
      redirectMode: "REDIRECT",
      callbackUrl: "https://your-callback-url.com",
      mobileNumber: customer.contact,
      paymentInstrument: {
        type: "PAY_PAGE"
      }
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payRequest)).toString("base64");
    const stringToSign = `${payloadBase64}/pg/v1/pay${SALT_KEY}`;
    const checksum = crypto.createHash("sha256").update(stringToSign).digest("hex") + `###${SALT_INDEX}`;

    const headers = {
      "Content-Type": "application/json",
      "X-VERIFY": checksum
    };

    const response = await axios.post(`${BASE_URL}/pg/v1/pay`, {
      request: payloadBase64
    }, { headers });

    if (response.data.success) {
      const paymentUrl = response.data.data.instrumentResponse.redirectInfo.url;
      res.json({ paymentLink: paymentUrl });
    } else {
      res.status(400).json({ message: "Failed to generate PhonePe payment link", error: response.data });
    }

  } catch (error) {
    console.error("Error generating PhonePe payment link:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error generating PhonePe payment link",
      error: error.response?.data || error.message
    });
  }
});

module.exports = router;