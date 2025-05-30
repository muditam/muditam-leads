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