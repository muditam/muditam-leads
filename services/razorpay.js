const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const router = express.Router();

const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;

const BASE_URL = "https://api.phonepe.com/apis/pg"; // change to production later
const PAYLINK_ENDPOINT = "/paylinks/v1/pay";

router.post("/create-payment-link", async (req, res) => {
  try {
    const { amount, customer } = req.body;

    const paiseAmount = Math.round(Number(amount) * 100);
    const merchantOrderId = `order_${Date.now()}`;
    const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days from now

    const payload = {
      merchantId: MERCHANT_ID,
      merchantOrderId, 
      amount: paiseAmount,
      metaInfo: {
        udf1: "Order via 60brands",
        udf2: customer.name || "", 
        udf3: customer.email || "",
        udf4: customer.contact || ""
      },
      paymentFlow: {
        type: "PAYLINK",
        customerDetails: {
          name: customer.name || "Customer",
          phoneNumber: customer.contact.startsWith("+91")
            ? customer.contact
            : "+91" + customer.contact.replace(/[^0-9]/g, ""),
          email: customer.email || "",
          notificationChannels: {
            SMS: false,
            EMAIL: false
          }
        },
        expireAt
      }
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");

    // Signature: SHA256(base64Payload + API_PATH + clientSecret)
    const stringToSign = base64Payload + PAYLINK_ENDPOINT + CLIENT_SECRET;
    const signature = crypto.createHash("sha256").update(stringToSign).digest("hex");

    const response = await axios.post(
      `${BASE_URL}${PAYLINK_ENDPOINT}`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type": "application/json",
          "X-VERIFY": signature + "###" + 1,
          "X-MERCHANT-ID": MERCHANT_ID
        },
      }
    );

    const data = response.data;
    const paylinkUrl = data.data?.paylinkUrl;

    if (response.status === 200 && paylinkUrl) {
      return res.json({
        paymentLink: paylinkUrl,
        orderId: data.data.orderId,
        expireAt: data.data.expireAt,
      });
    } else {
      return res.status(400).json({
        message: "Failed to create PhonePe paylink",
        details: data,
      });
    }

  } catch (error) {
    console.error("[PhonePe Error]", error.response?.data || error.message);
    return res.status(500).json({
      message: "PhonePe API Error",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
