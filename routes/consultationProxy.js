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

  if (req.headers.accept && req.headers.accept.includes("application/json")) {
    return res.status(400).json({ error: "This endpoint returns HTML, not JSON." });
  }

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
    const daysToAdd = 90;

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

    const presalesGender = consultationDetails.presales?.gender || "Not specified";

    // Get selected products from consultation details (if any)
    const selectedProducts = consultationDetails.consultation?.selectedProducts || [];

    // Map selected product names to their details (image URL and description)
    // Map selected product names to their details (image URL and description)
    const productDetailsMap = {
      "Karela Jamun Fizz": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/KJF_1.webp?v=1744809598",
        description: "Control blood sugar levels"
      },
      "Liver Fix": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/lf_2.webp?v=1744809988",
        description: "Support liver health"
      },
      "Sugar Defend Pro": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/SDP_2_4fdc364f-3197-4867-9f63-0022dcac2586.webp?v=1744875711",
        description: "Blood sugar control"
      },
      "Vasant Kusmakar Ras": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/VKR.webp?v=1744875711",
        description: "Metabolic fire balance"
      },
      "Stress & Sleep": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/S_S_9a0d9003-3f5f-4514-8a5a-4c014b5dea06.webp?v=1744875711",
        description: "Calming sleep"
      },
      "Chandraprabha Vati": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/CPV_309f6255-286c-4c40-8d44-eea07f5a5e36.webp?v=1744875711",
        description: "Urinary tract health"
      },
      "Heart Defend Pro": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/HDP_2.webp?v=1744875711",
        description: "Cardio support"
      },
      "Performance Forever": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/PF_2.webp?v=1744875711",
        description: "Endurance booster"
      },
      "Power Gut": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/PG_2_c7332d00-50b9-476e-aeb3-005babd4b95d.webp?v=1744875711",
        description: "Digestive balance"
      },
      "Blood Test": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/blood_test.webp?v=1744881342",
        description: "Body Check-Up"
      },
      "Shilajit with Gold": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Shilajit_3.webp?v=1744875711",
        description: "Cellular rejuvenation"
      }
    };

    const conditionMap = {
      "Karela Jamun Fizz": "Diabetes",
      "Sugar Defend Pro": "Diabetes",
      "Vasant Kusmakar Ras": "Diabetes",
      "Liver Fix": "Liver",
      "Stress & Sleep": "Sleep",
      "Chandraprabha Vati": "Kidney",
      "Heart Defend Pro": "Heart",
      "Performance Forever": "Vitality",
      "Power Gut": "Gut",
      "Shilajit with Gold": "Immunity",
    };


    // Generate the HTML for each product card
    let productCardsHtml = "";
    selectedProducts.forEach(product => {
      const details = productDetailsMap[product];
      if (!details) return;

      const condition = conditionMap[product] || "Condition";

      productCardsHtml += `
    <div
      style="
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 20px;
        margin: 10px 0;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      "
    > 
      <img
        src="${details.image}"
        alt="${product}"
        style="height: 120px; width: auto; object-fit: contain;"
      />
 
      <div style="flex: 1; margin: 0 20px;">
        <h2 style="margin: 0 0 5px; font-size: 22px;">${product}</h2>
        <p style="margin: 0 0 10px; font-size: 16px; color: #555;">
          ${details.description}
        </p>
        <hr style="border: none; height: 1px; background-color: #ccc; margin: 10px 0;" />
        <span style="font-size: 14px; font-weight: bold; color: #333;">
          ${condition}
        </span>
      </div>
 
      <img
        src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_130.png?v=1744809988"
        alt="tag"
        style="height: 30px; margin-left: 20px;"
      />
    </div>
  `;
    });

    // Generate add-ons section based on freebies
    const freebies = consultationDetails.closing?.freebie || [];
    const addOnMap = {
      "Dumbbells": "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/dumbells.webp?v=1744881971",
      "Glucometer +10 strips": "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Glucometer_1.webp?v=1744881970",
      "Glucometer +25 strips": "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/25_strip_glucometer.webp?v=1744882266",
      "Diet Plan": "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Diet_plan.webp?v=1744881970"
    };
    let addOnsHtml = "";
    if (freebies.length) {
      addOnsHtml += `
        <div class="addons-section">
          <h3 style="font-size:26px;margin-top:30px;margin-bottom:20px;">Complimentary Add‑ons for You</h3>
          <div class="addons-container">
      `;
      freebies.forEach(item => {
        const imgUrl = addOnMap[item];
        if (imgUrl) {
          addOnsHtml += `
            <div class="addon-item" style="flex:1;padding:10px;text-align:center;">
              <img src="${imgUrl}" alt="${item}" style="max-width:100%;height:auto;"/>
            </div>
          `;
        }
      });
      addOnsHtml += `
          </div>
        </div>
      `;
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head> 
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Consultation Plan for ${customer.name}</title>
          <!-- Prevent search engines from indexing this page -->
          <meta name="robots" content="noindex, nofollow">
          
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
            .Your-dce{
              font-size: 32px;
              font-weight: 400;
              color: #C0C0C0;
              text-align: center;
            }
            .Your-dce-sp{
              font-size: 40px;
              font-weight: 600;
              line-height: 30px;
            }
            .customer-dmp-top{
              text-align: left; 
              margin: 0;
            }
            .customer-dmp{
              font-size: 18px;
            }
            .customer-dmp-1{
              margin-top: 0px;
              font-size: 22px;
              color: #543087;
            }
            .customer-dmp-2{
              background-color: #F4F4F4;
              color: black;
              box-shadow: 0 0 4px 0;
              border-radius: 15px;
            }
            .Your-dce-d{
              padding: 10px;
            }
              .addons-container {
              display: flex;
              gap: 20px;
            }
             /* Risks section */
            .risks-section {
              margin-top: 40px;
              padding: 0 20px;
            }
            .risks-section h3 {
              font-size: 26px;
              font-weight: bold;
              margin-bottom: 10px;
            }
            .risks-section p {
              font-size: 14px;
              margin-bottom: 20px;
            }
            .risks-container {
              display: flex;
              flex-wrap: wrap;
              gap: 10px; 
            }
            .risk-block {
              display: flex;
              flex-direction: column;
              align-items: center;
              width: 100px;
              margin: 0 5px;
            }
            .risk-item {
              width: 100px;
              height: 100px;
              background: #F4F4F4;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 8px;
            }
            .risk-item img {
              width: 50px;
              height: 50px;
            }
            .risk-block p {
              margin: 5px 0 0;
              font-size: 12px;
              line-height: 1.2;
              text-align: center;
            }

            .kit-section .kit-items.desktop { display: flex; gap: 40px; }
            .kit-section .kit-items.mobile { display: none; }

               .kit-section {
                margin: 40px 20px;
              }
              .kit-section h3 {
                font-size: 26px;
                font-weight: bold;
                margin-bottom: 10px;
              }
              .kit-section p.intro {
                font-size: 14px;
                margin-bottom: 20px;
              }

              /* --- Desktop two columns --- */
              .kit-section .kit-items.desktop .col {
                flex: 1;
              }
              .kit-section .kit-items.desktop ul,
              .kit-section .kit-items.mobile ul {
                list-style: none;
                padding: 0;
                margin: 0;
              }
              .kit-section li {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                margin-bottom: 12px;
                font-size: 14px;
              }
              .kit-section li img.check {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
                margin-top: 3px;
              }
              @media only screen and (max-width: 767px) {
              .dmp-heading{
                font-size: 45px; 
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
                .addons-container {
                flex-direction: column;
                gap: 5px;
              }
              .risks-container {
                flex-wrap: nowrap;
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                scroll-snap-type: x mandatory;
                scroll-behavior: smooth;
              }
              .risk-item {
                scroll-snap-align: start;
              }
            }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="overlay">
                <h1 class="dmp-heading-h1">${customer.name}'s</h1>
                <h2 class="dmp-heading">DIABETES<br> MANAGEMENT<br> PLAN</h2>
                <div class="duration-badge">${consultationDetails.closing && consultationDetails.closing.courseDuration ? consultationDetails.closing.courseDuration : "Not provided"}</div>
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
          </div>

          <div class="Your-dce-d">
            <p class="Your-dce">Your<br><span class="Your-dce-sp">Diabetes Care</span><br>Essentials</p>
            
            <hr style="height: 1px; background-color: #C0C0C0; width: 70%;">

            <div class="customer-dmp-top"><p class="customer-dmp">${customer.name}'s</p></div>
            <p class="customer-dmp-1">Diabetes Management Plan</p>
            <span class="customer-dmp-2">${customer.age}/${presalesGender}</span>
          </div>

          ${productCardsHtml}
          ${addOnsHtml}

          <div class="risks-section">
            <h3>Risks of Uncontrolled Sugar Levels</h3>
            <p>
              If blood sugar isn’t well controlled, the risk of serious
              health complications increases, such as:
            </p>
            <div class="risks-container">
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Heart.png?v=1744884197" alt="Heart Disease" />
                </div>
                <p>Heart<br>Disease</p>
              </div>
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Nerve.png?v=1744884197" alt="Kidney Damage" />
                </div>
                <p>Kidney<br>Damage</p>
              </div>
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Nerve.png?v=1744884197" alt="Nerve Damage" />
                </div>
                <p>Nerve<br>Damage</p>
              </div>
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Foot.png?v=1744884197" alt="Foot Complications" />
                </div>
                <p>Foot<br>Complications</p>
              </div>
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/vision.png?v=1744884197" alt="Vision Problems" />
                </div>
                <p>Vision<br>Problems</p>
              </div>
              <div class="risk-block">
                <div class="risk-item">
                  <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/infection.png?v=1744884197" alt="Frequent Infections" />
                </div>
                <p>Frequent<br>Infections</p>
              </div>
            </div>
          </div>

          <div class="kit-section">
          <h3>What’s in the Customized Kit?</h3>
          <p class="intro">Inclusions:</p>

          <!-- DESKTOP: two columns -->
          <div class="kit-items desktop">
            <div class="col">
              <ul>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  A customised kit with Ayurvedic supplements tailored to your health needs
                </li>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  Personalised diabetes expert support to help you stay on track with your health goals
                </li>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  Timely follow‑up calls to track progress and adjust your plan as needed
                </li>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  Daily live yoga sessions to support your sugar control and mental well‑being
                </li>
              </ul>
            </div>
            <div class="col">
              <ul>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  A free one‑on‑one consultation with our doctor to understand your condition better
                </li>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  A customised Ayurvedic diet plan designed specifically for your body and lifestyle
                </li>
                <li>
                  <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                  Constant WhatsApp support for any queries, reminders, or motivation
                </li>
              </ul>
            </div>
          </div>

          <!-- MOBILE: single column -->
          <div class="kit-items mobile">
            <ul>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                A customised kit with Ayurvedic supplements tailored to your health needs
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                Personalised diabetes expert support to help you stay on track with your health goals
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                Timely follow‑up calls to track progress and adjust your plan as needed
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                Daily live yoga sessions to support your sugar control and mental well‑being
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                A free one‑on‑one consultation with our doctor to understand your condition better
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                A customised Ayurvedic diet plan designed specifically for your body and lifestyle
              </li>
              <li>
                <img class="check" src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/checked_6.png?v=1744888769" alt="✓"/>
                Constant WhatsApp support for any queries, reminders, or motivation
              </li>
            </ul>
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
