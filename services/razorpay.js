const express = require("express");
const Razorpay = require("razorpay");
const router = express.Router();
 
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
 
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

 