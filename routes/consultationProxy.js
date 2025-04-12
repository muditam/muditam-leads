const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

router.get("/proxy/consultation/:slug", async (req, res) => {
    const slug = req.params.slug;
    try {
        // Find customer by slug instead of using findById()
        const customer = await Customer.findOne({ slug }).lean();
        if (!customer) return res.status(404).send("Customer not found");

        // Use the customer's _id to look up consultation details if that's how they're linked
        const consult = await ConsultationDetails.findOne({ customerId: customer._id }).lean();

        // Build and send the HTML page with responsive background images
        const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <title>Consultation Plan</title>
            <meta name="robots" content="noindex, nofollow" />
            <style>
              /* Default (desktop) background image */
              body {
                margin: 0;
                padding: 0;
                background: url('https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_04_42_09_PM_1.jpg?v=1744455727') no-repeat center center fixed;
                background-size: cover;
                font-family: Arial, sans-serif;
                color: white;
              }
              /* Mobile background image */
              @media only screen and (max-width: 767px) {
                body {
                  background: url('https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_12_36_24_PM_1.png?v=1744455727') no-repeat center center fixed;
                  background-size: cover;
                }
              }
              /* Full-screen overlay to contain content */
              .overlay {
                position: relative;
                width: 100%;
                height: 100vh;
              }
              /* Position content to begin at 40% from the top */
              .content {
                position: absolute;
                top: 40%;
                width: 100%;
                text-align: center;
              }
              .customer-name {
                font-size: 2.5rem;
                font-weight: bold;
                margin-bottom: 20px;
              }
              .title-text {
                font-size: 2rem;
                line-height: 1.2;
              }
              /* Course duration is displayed in a black box with white text */
              .course-duration {
                margin-top: 20px;
                background: black;
                padding: 10px 20px;
                display: inline-block;
                color: white;
                font-size: 1.2rem;
              }
            </style>
          </head>
          <body>
            <div class="overlay">
              <div class="content">
                <div class="customer-name">${customer.name}</div>
                <div class="title-text">Diabetes<br>Management<br>Plan</div>
                <div class="course-duration">
                  ${consult && consult.closing ? consult.closing.courseDuration : "N/A"}
                </div>
              </div>
            </div>
          </body>
        </html>
        `;
        res.setHeader("Content-Type", "text/html");
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send("Server error");
    }
});

module.exports = router;
