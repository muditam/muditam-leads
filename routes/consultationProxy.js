const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");

function formatMonthDay(dateObj) {
  const month = dateObj.toLocaleString("en-US", { month: "long" });
  const day = dateObj.getDate();
  return `${month} ${day}`;
}

const priceMap = {
  "Karela Jamun Fizz": {
    "1 month": 1350,
    "2 months": 2650,
    "3 months": 3800,
    "4 months": 4500,
  },
  "Sugar Defend Pro": {
    "1 month": 1495,
    "2 months": 2700,
    "3 months": 3500,
    "4 months": 4200,
  },
  "Vasant Kusmakar Ras": {
    "1 month": 2995,
    "2 months": 4200,
    "3 months": 5800,
    "4 months": 6500,
  },
  "Liver Fix": {
    "1 month": 1550,
    "2 months": 2900,
    "3 months": 3600,
    "4 months": 6400,
  },
  "Stress & Sleep": {
    "1 month": 799,
    "2 months": 1395,
    "3 months": 2200,
    "4 months": 2750,
  },
  "Chandraprabha Vati": {
    "1 month": 525,
    "2 months": 999,
    "3 months": 1350,
    "4 months": 1600,
  },
  "Power Gut": {
    "1 month": 1515,
    "2 months": 2695,
    "3 months": 3595,
    "4 months": 4200,
  },
  "Heart Defend Pro": {
    "1 month": 1950,
    "2 months": 3600,
    "3 months": 4500,
    "4 months": 5400,
  },
  "Performance Forever": {
    "1 month": 999,
    "2 months": 1799,
    "3 months": 2499,
    "4 months": 3199,
  },
  "Shilajit with Gold": {
    "1 month": 1295,
    "2 months": 2495,
    "3 months": 3495,
    "4 months": 4495,
  },
};

const variantMap = {
  "Karela Jamun Fizz": {
    "1 month": "44827667169590",
    "2 months": "44850184978742",
    "3 months": "44827667202358",
    "4 months": "44827667136822",
  },
  "Sugar Defend Pro": {
    "1 month": "44842989060406",
    "2 months": "44842989093174",
    "3 months": "44842989027638",
    "4 months": "44850265915702",
  },
  "Vasant Kusmakar Ras": {
    "1 month": "48319092949302",
    "2 months": "48791244603702",
    "3 months": "48319093014838",
    "4 months": "48319093014838",
  },
  "Liver Fix": {
    "1 month": "48209288757558",
    "2 months": "48209288790326",
    "3 months": "48209288823094",
    "4 months": "48209288855862",
  },
  "Stress & Sleep": {
    "1 month": "48352977518902",
    "2 months": "48352977518902",
    "3 months": "48352977551670",
    "4 months": "48352977486134",
  },
  "Chandraprabha Vati": {
    "1 month": "48212219298102",
    "2 months": "48212219265334",
    "3 months": "48212219330870",
    "4 months": "48212219363638",
  },
  "Heart Defend Pro": {
    "1 month": "48207232336182",
    "2 months": "48207232368950",
    "3 months": "48207232401718",
    "4 months": "48207232434486",
  },
  "Performance Forever": {
    "1 month": "48204586352950",
    "2 months": "48204586320182",
    "3 months": "48204586385718",
    "4 months": "48204586418486",
  },
  "Shilajit with Gold": {
    "1 month": "51280956916022",
    "2 months": "51280956948790",
    "3 months": "51280956981558",
    "4 months": "51280957014326",
  },
  "Power Gut": {
    "1 month": "51200287670582",
    "2 months": "51200287703350",
    "3 months": "51200287736118",
    "4 months": "51200287768886",
  },
};

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

    let totalPrice = 0;
    selectedProducts.forEach((prod) => {
      const pricing = priceMap[prod] || {};
      totalPrice += pricing[courseDuration] || 0;
    });
    // fallback if nothing matched:
    if (totalPrice === 0) totalPrice = 0;

    // 6) COMPUTE DISCOUNT & FINAL
    const specialDiscount = 70;
    const discount       = Math.round(totalPrice * 0.10);
    const finalPrice     = totalPrice - discount - specialDiscount;
 
    const variantIds = selectedProducts.reduce((arr, prod) => {
      const m = variantMap[prod];
      if (m && m[courseDuration]) arr.push(m[courseDuration]);
      return arr;
    }, []);
    const payUrl = variantIds.length
      ? `https://www.muditam.com/cart/${variantIds.map(id => id + ":1").join(",")}`
      : "#";

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
                 .turning-section-amg {
                  text-align: center;
                  padding: 8px;
                  font-family: 'Poppins', sans-serif;
                }
                .turning-section-amg h2 {
                  margin: 0;
                  font-size: 36px;
                  font-weight: 700;
                  color: #B0B0B0;
                  line-height: 1;
                }
                .subtitle-amg {
                  margin: 8px 0 40px;
                  font-size: 20px;
                  color: #666;
                }

                .rating-cards-amg {
                  display: flex;
                  justify-content: center;
                  gap: 24px;
                }

                .rating-card-amg {
                  display: flex;
                  align-items: center;
                  background: #F4F4F4;
                  border-radius: 16px;
                  padding: 16px 24px;
                  min-width: 300px;
                  box-sizing: border-box;
                }
                .center-amg {
                  background: #FFFFFF;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                }

                .logo-amg {
                  width: 50px;
                  height: 50px;
                  object-fit: contain;
                }
                .sep-amg {
                  width: 1px;
                  height: 50px;
                  background: #CCCCCC;
                  margin: 0 24px;
                }
                .content-amg {
                  text-align: left;
                }
                .name-amg {
                  display: none;
                  font-size: 16px;
                  font-weight: 600;
                  margin: 0 0 4px;
                  color: #222;
                }
                .score-amg {
                  font-size: 32px;
                  font-weight: 700;
                  margin: 0;
                  color: #222;
                }
                .caption-amg {
                  font-size: 14px;
                  color: #777;
                  margin-top: 4px;
                }
                .payment-breakup-amg {
                max-width:420px;margin:40px auto;border:1px solid #E0E0E0;
                border-radius:8px;overflow:hidden;background:#FFF;
                font-family:'Poppins',sans-serif;
              }
              .payment-breakup-amg h3 {
                margin:0;padding:20px 24px 12px;
                font-size:22px;font-weight:600;color:#222;
              }
              .payment-breakup-amg .pb-line {
                margin:0 24px;border:none;height:1px;
                background:#E0E0E0;
              }
              .payment-breakup-amg .pb-row {
                display:flex;justify-content:space-between;
                padding:12px 24px;font-size:16px;color:#333;
                align-items:center;
              }
              .payment-breakup-amg .pb-row.pb-final .pb-amount {
                font-weight:700;
              }
              .payment-breakup-amg .pb-amount { font-weight:500 }
              .payment-breakup-amg .pb-cta {
                width:calc(100% - 48px);margin:16px auto;
                padding:14px 0;border-radius:999px;text-align:center;
                cursor:pointer;text-decoration:none;display:block;
              }
              .payment-breakup-amg .pb-cta.book {
                background:#ECDFFF;color:#222;
              }
              .payment-breakup-amg .pb-cta.book p {
                margin:0;font-size:18px;font-weight:500;
              }
              .payment-breakup-amg .pb-cta.book small {
                display:block;margin-top:4px;
                font-size:14px;color:#555;
              }
              .payment-breakup-amg .pb-cta.pay {
                background:#0984E3;color:#FFF;
              }
              .payment-breakup-amg .pb-cta.pay p {
                margin:0;font-size:20px;font-weight:600;
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
                .kit-section .kit-items.desktop { display: none; }
              .kit-section .kit-items.mobile { display: block; }
              .rating-cards-amg { 
                align-items: center;
                gap: 16px;
              }
              .rating-card-amg {
                flex-direction: column;
                align-items: center;
                width: 100%;
                max-width: 280px;
                padding: 12px 16px;
                min-width: auto;
              }
              .center-amg {
                padding: 14px 18px;
              }
              .logo-amg {
                margin-top: -35px;
              }
              .sep-amg {
                display: none;
              }
              .content-amg {
                text-align: center;
                margin-top: 8px;
              }
              .name-amg {
                display: block;
                font-size: 14px;
              }
              .score-amg {
                font-size: 28px;
              }
              .caption-amg {
                font-size: 12px;
              }
              .payment-breakup-amg{margin:24px 16px}
              .payment-breakup-amg h3{padding:16px 16px 8px;font-size:20px}
              .payment-breakup-amg .pb-row{padding:10px 16px;font-size:14px}
              .payment-breakup-amg .pb-cta{margin:12px auto;width:calc(100% - 32px);padding:12px 0}
              .payment-breakup-amg .pb-cta.book p{font-size:16px}
              .payment-breakup-amg .pb-cta.book small{font-size:12px}
              .payment-breakup-amg .pb-cta.pay p{font-size:18px}
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

        <div class="turning-section-amg">
        <h2>TURNING POINTS</h2>
        <p class="subtitle-amg">Stories of Health & Hope</p>

        <div class="rating-cards-amg">
          <!-- Google card -->
          <div class="rating-card-amg">
            <img class="logo-amg"
                src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Google_f0d1f0d3-8ea4-4586-9bde-9ec454630757.webp?v=1744889830"
                alt="Google"/>
            <div class="sep-amg"></div>
            <div class="content-amg">
              <p class="name-amg">Google</p>
              <p class="score-amg">4.9</p>
              <p class="caption-amg">Star rating</p>
            </div>
          </div>

          <!-- Muditam card (center, white) -->
          <div class="rating-card-amg center-amg">
            <img class="logo-amg"
                src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam.webp?v=1744890066"
                alt="Muditam"/>
            <div class="sep-amg"></div>
            <div class="content-amg">
              <p class="name-amg">Muditam</p>
              <p class="score-amg">4.9</p>
              <p class="caption-amg">Star rating</p>
            </div>
          </div>

          <!-- Amazon card -->
          <div class="rating-card-amg">
            <img class="logo-amg"
                src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Amazon_46a9086d-3c17-4de5-8583-c6076b7cac6a.webp?v=1744890090"
                alt="Amazon"/>
            <div class="sep-amg"></div>
            <div class="content-amg">
              <p class="name-amg">Amazon</p>
              <p class="score-amg">4.8</p>
              <p class="caption-amg">Star rating</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Payment Breakup Section -->
    <div class="payment-breakup-amg">
      <h3>Payment Breakup</h3>
      <hr class="pb-line" />

      <div class="pb-row">
        <span>Diabetes Management Plan Price:</span>
        <span class="pb-amount">₹${totalPrice}</span>
      </div>
      <hr class="pb-line" />

      <div class="pb-row">
        <span>Discount:</span>
        <span class="pb-amount">₹${discount}</span>
      </div>
      <hr class="pb-line" />

      <div class="pb-row">
        <span>Special Discount:</span>
        <span class="pb-amount">₹${specialDiscount}</span>
      </div>
      <hr class="pb-line" />

      <div class="pb-row pb-final">
        <span>Final Price:</span>
        <span class="pb-amount">₹${finalPrice}</span>
      </div>
      <hr class="pb-line" />

      <a class="pb-cta pay" href="${payUrl}">
      <p>Pay Now ₹${finalPrice}/–</p>
    </a>
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
