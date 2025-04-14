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

    // Build an HTML response with a wrapper div that does the styling.
    let daysExpected = "";
    const cd = courseDuration.toLowerCase().trim();
    if (cd === "1 month") {
      daysExpected = "30 days";
    } else if (cd === "2 months") {
      daysExpected = "60 days";
    } else if (cd === "3 months") {
      daysExpected = "90 days";
    } else if (cd === "4 months") {
      daysExpected = "120 days";
    } else {
      daysExpected = "Not available";
    }

    const goalDate = new Date();
    goalDate.setDate(goalDate.getDate() + daysToAdd);
    const goalDateString = formatMonthDay(goalDate) + " Goal";

    // Get presales Hba1c (if available); use a default value if missing
    const presalesHba1c = parseFloat(consultationDetails.presales?.hba1c) || 8.0;

    // Compute goal Hba1c based on expectedResult (for demonstration, using simple logic)
    // Default improvement drop is 0.8; if expectedResult is "2" then 1.5, if "3" then 2.5.
    let improvementDrop = 0.8;
    if (consultationDetails.closing?.expectedResult === "2") {
      improvementDrop = 1.5;
    } else if (consultationDetails.closing?.expectedResult === "3") {
      improvementDrop = 2.5;
    }
    const goalHba1c = (presalesHba1c - improvementDrop).toFixed(1);

    // Compute left positions for pointer-current and pointer-goal:
    // For pointer-current: if currentHba1c is 8 => 22%, 9 => 20%, etc.
    const pointerCurrentLeft = 22 - 2 * (presalesHba1c - 8); // in percent

    // For pointer-goal: using provided examples: if goalHba1c is 10 => 21%, if 9 => 27%, if 8 => 33%.
    // A linear formula: pointerGoalLeft = 27 + 6 * (9 - goalHba1c)
    const pointerGoalLeft = 27 + 6 * (9 - goalHba1c);

    // Current date string (Month day)
    const currentDate = new Date();
    const currentDateString = formatMonthDay(currentDate);
    const currentHba1c = presalesHba1c.toFixed(1);

    // Build the HTML
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
              top: 10px; /* adjust if needed */
              width: 25px;
              height: 25px;
            }
            .pointer-goal {
              position: absolute;
              top: 10px; /* adjust if needed */
              width: 25px;
              height: 25px;
            }
            /* Current info: position absolutely; text aligned right */
            .current-info {
              position: absolute;
              top: 80px; /* adjust vertical placement as needed */
              width: 100%;
              text-align: right;
              font-size: 14px;
            }
            /* Goal info: position absolutely; text aligned left */
            .goal-info {
              position: absolute;
              top: 40px; /* adjust vertical placement as needed */
              text-align: left;
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
            <h3 class="results-expected-h3">${daysToAdd} days</h3>
          </div>
          <!-- Goal Info Section (positioned based on pointer-goal) -->
          <div class="goal-info" style="left: ${pointerGoalLeft}%;">
            <p class="goal-date">${goalDateString}</p>
            <p class="goal-hba1c" style="color: green;">${goalHba1c}%</p>
          </div>
          <!-- Bar Section with Pointers and Current Info -->
          <div class="bar-section">
            <img class="bar-image" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/bar.webp?v=1744629571" alt="Color Bar"/>
            <img class="pointer-current" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Circle.webp?v=1744629571" alt="Current Pointer" style="left: ${pointerCurrentLeft}%;">
            <img class="pointer-goal" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/circle_with_arrow.webp?v=1744629571" alt="Goal Pointer" style="left: ${pointerGoalLeft}%;">
            <div class="current-info" style="left: ${pointerCurrentLeft}%;">
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