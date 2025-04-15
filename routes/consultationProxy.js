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

    const gender = consultationDetails.presales?.gender || "Not provided";

    // Compute the goal date as current date + daysToAdd and format it
    const goalDate = new Date();
    goalDate.setDate(goalDate.getDate() + daysToAdd);
    const goalDateString = formatMonthDay(goalDate) + " Goal";

    // Compute current date string
    const currentDate = new Date();
    const currentDateString = formatMonthDay(currentDate);

    // Retrieve presales Hba1c (default to 8.0 if not provided)
    let presalesHba1c = parseFloat(consultationDetails.presales?.hba1c) || 8.0;
    const currentHba1c = presalesHba1c.toFixed(1);

    // Compute default goal Hba1c using a default improvement (for "Only Supplements")
    let defaultImprovement = 0.8; // default improvement for Only Supplements
    let goalHba1c = (presalesHba1c - defaultImprovement).toFixed(1);

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
            .pointer-current {
              position: absolute;
              top: 10px;
              left: 20%;
              transform: translate(-50%, -50%);
              width: 25px;
              height: 25px;
            }
            .pointer-goal {
              position: absolute;
              top: 10px;
              left: 80%;
              transform: translate(-50%, -50%);
              width: 25px;
              height: 25px;
            }
            .current-info {
              position: absolute;
              bottom: -20px;
              right: 0;
              font-size: 14px;
              text-align: right;
            }
            /* Goal Section */
            .goal-section {
              text-align: center;
              margin: 20px auto;
            }
            .goal-date {
              font-size: 24px;
              font-weight: 500;
              margin: 10px 0 0;
            }
            .goal-hba1c {
              color: green;
              font-size: 32px;
              margin: 10px 0 0;
              font-weight: 600;
              text-align: center;
            }
            .current-bar-info {
              text-align: right;
              font-size: 14px;
              margin-top: 10px;
            }
            .select-option-label {
              margin: 20px 0 10px;
              font-size: 18px;
            }
            .expected-options { 
              justify-content: center;
              gap: 10px;
            }
            .option-box { 
            display: flex;
              align-items: center;
              background-color: #F4F4F4;
              padding: 5px 10px;
              border-radius: 4px;
              cursor: pointer;
            }
            .option-box input {
              margin-right: 5px;
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
            <h3 class="results-expected-h3">90 Days</h3>
          </div>
          <!-- Goal Section -->
          <div class="goal-section">
            <p class="goal-date">${goalDateString}</p>
            <p class="goal-hba1c" id="goalHba1cDisplay">${goalHba1c}%</p>
            <!-- Goal pointer image (if needed) -->
            <div class="goal-pointer-image">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/HbA1c_Bar.webp?v=1744635117" alt="Goal Pointer" style="width:90%;height:60px;">
            </div>
            <!-- Current bar info: current date and current Hba1c -->
            <div class="current-bar-info">
              <p>${currentDateString}: ${currentHba1c}%</p>
            </div>
            <p class="select-option-label">Select an option to see expected results</p>
            <div class="expected-options">
              <label class="option-box">
                <input type="checkbox" name="expectedOption" value="only" onchange="updateGoalHba1c(this)" />
                <span>Only Supplements</span>
              </label>
              <label class="option-box">
                <input type="checkbox" name="expectedOption" value="diet" onchange="updateGoalHba1c(this)" />
                <span>With Diet & Supplements</span>
              </label>
              <label class="option-box">
                <input type="checkbox" name="expectedOption" value="lifestyle" onchange="updateGoalHba1c(this)" />
                <span>With Diet, Lifestyle modifications & Supplements</span>
              </label>
            </div>
            <div><p class="Your-dce">Your<br><span class="Your-dce-sp">Diabetes Care</span><br>Essentials</p></div>
            
            <hr>
            
            
            </div>
          </div>
          <script>
            var currentHba1c = ${presalesHba1c};
            function updateGoalHba1c(selected) {
              // Uncheck all other checkboxes
              var checkboxes = document.querySelectorAll('input[name="expectedOption"]');
              checkboxes.forEach(function(box) {
                box.checked = false;
              });
              selected.checked = true;
              var newGoal;
              if (selected.value === "only") {
                newGoal = currentHba1c - 0.8;
              } else if (selected.value === "diet") {
                newGoal = currentHba1c - 1.5;
              } else if (selected.value === "lifestyle") {
                newGoal = currentHba1c - 2.5;
              }
              document.getElementById("goalHba1cDisplay").textContent = newGoal.toFixed(1) + "%";
            }
          </script>
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