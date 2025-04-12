const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

// GET route for App Proxy using customer ID directly
router.get("/proxy/consultation/:id", async (req, res) => {
    const customerId = req.params.id;

    try {
        // Fetch customer data using customerId
        const customer = await Customer.findById(customerId).lean();
        if (!customer) {
            return res.status(404).send("Customer not found.");
        }

        // Fetch consultation details using customerId
        const consultationDetails = await ConsultationDetails.findOne({ customerId }).lean();
        if (!consultationDetails) {
            return res.status(404).send("Consultation details not found.");
        }

        const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Consultation Plan</title>
    <meta name="robots" content="noindex, nofollow" />
    <style>
      /* Use a container for the background so body tag remains untouched */
      .background-container {
        width: 100%;
        min-height: 100vh;
        background-size: cover;
        background-position: center;
        position: relative;
      }
      /* Desktop background image */
      @media only screen and (min-width: 769px) {
        .background-container {
          background-image: url('https://cdn.shopify.com/s/files/1/0929/2323/2544/files/ChatGPT_Image_Apr_11_2025_04_42_09_PM_1.jpg?v=1744458517');
        }
      }
      /* Mobile background image */
      @media only screen and (max-width: 768px) {
        .background-container {
          background-image: url('https://cdn.shopify.com/s/files/1/0929/2323/2544/files/ChatGPT_Image_Apr_11_2025_12_36_24_PM_1.png?v=1744458517');
        }
      }
      /* Overlay with content */
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
        color: white;
        font-size: 1.2rem;
      }
    </style>
  </head>
  <body>
    <div class="background-container">
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
    } catch (error) {
        console.error("Error in consultation proxy route:", error);
        res.status(500).send("Internal server error");
    }
});

module.exports = router;