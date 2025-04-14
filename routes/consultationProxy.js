const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

function formatMonthDay(dateObj) {
  const month = dateObj.toLocaleString("en-US", { month: "long" });
  const day = dateObj.getDate();
  return `${month} ${day}`;
}

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

    const courseDuration = consultationDetails.closing?.courseDuration || "Not provided";

    let daysToAdd = 0;
    let daysExpected = "";
    const cd = courseDuration.toLowerCase().trim();
    if (cd === "1 month") {
      daysToAdd = 30;
      daysExpected = "30 days";
    } else if (cd === "2 months") {
      daysToAdd = 60;
      daysExpected = "60 days";
    } else if (cd === "3 months") {
      daysToAdd = 90;
      daysExpected = "90 days";
    } else if (cd === "4 months") {
      daysToAdd = 120;
      daysExpected = "120 days";
    } else {
      daysExpected = "Not available";
    }

    // Compute goal date by adding daysToAdd to the current date
    const goalDate = new Date();
    goalDate.setDate(goalDate.getDate() + daysToAdd);
    const goalDateString = formatMonthDay(goalDate) + " Goal";

    // Compute presales Hba1c; default is 8.0 if not available
    const presalesHba1c = parseFloat(consultationDetails.presales?.hba1c) || 8.0;

    // Compute goal Hba1c (naive drop calculation)
    let improvementDrop = 0.8; // default for expectedResult "1"
    if (consultationDetails.closing?.expectedResult === "2") {
      improvementDrop = 1.5;
    } else if (consultationDetails.closing?.expectedResult === "3") {
      improvementDrop = 2.5;
    }
    const goalHba1c = (presalesHba1c - improvementDrop).toFixed(1);

    // Current date and current Hba1c formatted
    const currentDate = new Date();
    const currentDateString = formatMonthDay(currentDate);
    const currentHba1c = presalesHba1c.toFixed(1);

    // Compute dynamic pointer positions (in percent)
    // Example: for pointer-current, map Hba1c (8 => 22%, 9 => 20%, etc.)
    const pointerCurrentLeft = 22 - 2 * (presalesHba1c - 8); // simple linear formula

    // For pointer-goal, sample formula (e.g., if goalHba1c = 9 then 27%, if 8 then 33%, if 10 then 21%)
    const pointerGoalLeft = 27 + 6 * (9 - goalHba1c);

    const html = `
      <!DOCTYPE html>
      <html>
        <head> 
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Consultation Plan for ${customer.name}</title>
          <!-- Prevent search engines from indexing this page -->
          <meta name="robots" content="noindex, nofollow">
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Poppins:wght@300;400;500;600;700&display=swap">
          <style>
            body { 
              margin: 0; 
              padding: 0; 
              font-family: 'Poppins', sans-serif;
            }
            .wrapper {
              min-height: 100vh;
              background-size: cover;
              background-repeat: no-repeat;
              background-position: center center;
            }
            @media only screen and (max-width: 767px) {
              .wrapper {
                background-image: url("https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_12_36_24_PM_1.png?v=17444557273");
              }
            }
            @media only screen and (min-width: 768px) {
              .wrapper {
                background-image: url("https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_11_2025_04_42_09_PM_1.jpg?v=1744455727");
              }
            }
            .container {
              min-height: 100vh;
              display: flex;
              align-items: center; 
              text-align: center;
              padding: 20px;
              box-sizing: border-box;
            }
            .overlay { 
              color: #fff;
              padding: 20px 30px;
              border-radius: 8px;
              max-width: 90%;  
              text-align: left;
            }
            .dmp-heading{
              font-size: 120px;
              font-weight: 500;
              margin: 0;
              font-family: 'Bebas Neue', cursive;
              letter-spacing: 5px;
              line-height: 120px;
            }
            .dmp-heading-h1{
              font-size: 60px;
              font-weight: 400;
              margin: 0 auto 10px;
            }
            .duration-badge {
              display: inline-block;
              background-color: #000;
              color: #fff;
              padding: 5px 15px;
              border-radius: 10px;
              margin-top: 10px;
              font-size: 50px;
            }
            @media only screen and (max-width: 767px) {
              .dmp-heading{
                font-size: 50px; 
                line-height: 60px;
                letter-spacing: 3px;
              }
              .dmp-heading-h1{
                font-size: 30px;
                font-weight: 400;
                margin: 0 auto 10px;
              }
              .duration-badge {
                font-size: 25px;
                padding: 5px 15px;
              }
            }
            .additional-image {
              text-align: center;
              margin-top: 20px;
              width: 100%;
            }
            .additional-image img {
              width: 100%;
              height: auto;
            }
            .results-expected { 
              margin: 20px 0; 
              padding: 10px;
              font-family: 'Poppins', sans-serif;
              text-align: left;
            }
            .results-expected-p {
              font-size: 32px;
              color: #5D5D5D !important;
              font-weight: 400;
              margin: 0;
            }
            .results-expected-h3 {
              font-size: 40px;
              margin: 5px 0 0;
              color: #848484 !important;
              font-weight: 600; 
            }
            /* Bar + pointer images section */
            .bar-section {
              width: 100%;
              max-width: 500px;
              margin: 20px auto;
              position: relative;
              text-align: center;
            }
            .bar-image {
              width: 100%;
              display: block;
              margin: 0 auto;
            }
            /* Pointer images: positions set dynamically via inline styles */
            .pointer-current {
              position: absolute;
              top: 10px;
              width: 25px;
              height: 25px;
            }
            .pointer-goal {
              position: absolute;
              top: 10px;
              width: 25px;
              height: 25px;
            }
            /* Current info: positioned absolutely; text aligned right */
            .current-info {
              position: absolute;
              top: 40px; /* adjust as needed */
              width: 100%;
              text-align: right;
              font-size: 14px;
            }
            /* Goal info: positioned absolutely; text aligned left */
            .goal-info {
              position: absolute;
              top: 40px; /* adjust as needed */
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="overlay">
                <h1 class="dmp-heading-h1">${customer.name}'s</h1>
                <h2 class="dmp-heading">DIABETES<br> MANAGEMENT<br> PLAN</h2>
                <div class="duration-badge">${courseDuration}</div>
              </div>
            </div>
          </div>
          <!-- Additional Image Section -->
          <div class="additional-image">
            <picture>
              <source media="(min-width: 768px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/d.webp?v=1744625952">
              <source media="(max-width: 767px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/m.webp?v=1744625953">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/d.webp?v=1744625952" alt="Additional Visual">
            </picture>
          </div>
          <!-- Results Expected Section -->
          <div class="results-expected">
            <p class="results-expected-p">Results Expected in</p>
            <h3 class="results-expected-h3">${daysExpected}</h3>
          </div>
          <!-- Display goal info (goal date and goal Hba1c) at dynamic position -->
          <div class="goal-info" style="left: ${pointerGoalLeft}%; position: absolute;">
            <p class="goal-date">${goalDateString}</p>
            <p class="goal-hba1c" style="color: green;">${goalHba1c}%</p>
          </div>
          <!-- Bar Section with Pointers and Current Info -->
          <div class="bar-section">
            <img class="bar-image" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/bar.webp?v=1744629571" alt="Color Bar"/>
            <img class="pointer-current" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Circle.webp?v=1744629571" alt="Current Pointer" style="left: ${pointerCurrentLeft}%;">
            <img class="pointer-goal" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/circle_with_arrow.webp?v=1744629571" alt="Goal Pointer" style="left: ${pointerGoalLeft}%;">
            <div class="current-info" style="left: ${pointerCurrentLeft}%; position: absolute; text-align: right;">
              <p>${currentDateString}: ${currentHba1c}%</p>
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