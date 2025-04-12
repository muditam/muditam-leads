const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

// GET route for App Proxy using customer ID directly
router.get("/proxy/consultation/:slug", async (req, res) => {
    const slug = req.params.slug;
    try {
        // Find customer by slug instead of using findById()
        const customer = await Customer.findOne({ slug }).lean();
        if (!customer) return res.status(404).send("Customer not found");

        // Use the customer's _id to look up consultation details if that's how they're linked
        const consult = await ConsultationDetails.findOne({ customerId: customer._id }).lean();

        // Build and send the HTML page using a container div for the background image
        const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <title>Consultation Plan</title>
            <meta name="robots" content="noindex, nofollow" />
            <style>
              /* Reset and set full height */
              html, body {
                margin: 0;
                padding: 0;
                height: 100%;
                position: relative;
                font-family: Arial, sans-serif;
              }
              /* Container for image and overlay */
              .container {
                width: 100%;
                height: 100%;
                position: relative;
                overflow: hidden;
              }
              /* The background image element fills the container */
              .bg-img {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                object-fit: cover;
                z-index: -1;
              }
              /* Overlay holds the content */
              .overlay {
                position: absolute;
                top: 40%;
                width: 100%;
                text-align: center;
                transform: translateY(-40%);
                color: white;
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
              .course-duration {
                margin-top: 20px;
                background: black;
                padding: 10px 20px;
                display: inline-block;
                font-size: 1.2rem;
                color: white;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <img
                class="bg-img"
                src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_12_36_24_PM_1.png?v=1744455727"
                alt="Background">
              <div class="overlay">
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