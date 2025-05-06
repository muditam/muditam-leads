const express = require("express");
const router = express.Router();
const ConsultationDetails = require("../models/ConsultationDetails");
const Customer = require("../models/Customer");
const Employee = require("../models/Employee");

function formatMonthDay(dateObj) {
  const month = dateObj.toLocaleString("en-US", { month: "long" });
  const day = dateObj.getDate();
  return `${month} ${day}`;
}

function formatDayMonthYear(dateObj) {
  const day   = dateObj.getDate();
  const month = dateObj.toLocaleString("en-US", { month: "long" });
  const year  = dateObj.getFullYear();
  return `${day} ${month} ${year}`;
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
    "2 months": 2995,
    "3 months": 5800,
    "4 months": 5800,
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
  "HbA1c - Blood Test": {
    "1 month": 300,
    "2 months": 300,
    "3 months": 300,
    "4 months": 300,
  },
  "Full Body Checkup": {
    "1 month": 900,
    "2 months": 900,
    "3 months": 900,
    "4 months": 900,
  },
  "Lipid + HbA1c + Liver": {
    "1 month": 650,
    "2 months": 650,
    "3 months": 650,
    "4 months": 650,
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
    "2 months": "48319092949302",
    "3 months": "48319092949302",
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
  "HbA1c - Blood Test": { 
    "1 month": "51848104247606",
    "2 months": "51848104247606",
    "3 months": "51848104247606",
    "4 months": "51848104247606",
  },
  "Full Body Checkup": {
    "1 month": "51848105722166",
    "2 months": "51848105722166",
    "3 months": "51848105722166",
    "4 months": "51848105722166",
  },
  "Lipid + HbA1c + Liver": {
    "1 month": "51848108310838",
    "2 months": "51848108310838",
    "3 months": "51848108310838",
    "4 months": "51848108310838",
  },
};

const couponValueMap = {
  DOCTORSPECIAL100: 100,
  DOCTORSPECIAL500: 500,
  DOCTORSPECIAL1000: 1000,
};

const percentageCouponMap = {
  DOCTORSPECIAL5:  0.05,
  DOCTORSPECIAL10: 0.10,
  DOCTORSPECIAL12: 0.12,
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
    const goalDateString = `${formatDayMonthYear(goalDate)} Goal`;

    // Compute current date string
    const currentDate = new Date();
    const currentDateString = formatDayMonthYear(currentDate);

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

    // sum up their ₹ amounts
    let couponDiscount = 0;
    const codes = consultationDetails.closing?.discountCodes || [];

    codes.forEach(code => {
      if (couponValueMap[code]) {
        // fixed-amount coupon
        couponDiscount += couponValueMap[code];
      } else if (percentageCouponMap[code]) {
        // percentage coupon
        couponDiscount += totalPrice * percentageCouponMap[code];
      }
    });

    // final price after subtracting coupon total
    const finalPrice = Math.max(0, totalPrice - couponDiscount);

    // collect all selected variants for the cart
    const variantIds = selectedProducts
      .map(prod => variantMap[prod]?.[courseDuration])
      .filter(Boolean);

    // build cart permalink, appending ?discount=CODE1,CODE2
    const cartPath = variantIds.map(id => `${id}:1`).join(",");
    const discountParam = codes.length ? `?discount=${codes.join(",")}` : "";
    const payUrl = variantIds.length
      ? `https://www.muditam.com/cart/${cartPath}${discountParam}`
      : "#";

    // Map selected product names to their details (image URL and description) 
    const productDetailsMap = {
      "Karela Jamun Fizz": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/KJF_1.webp?v=1744809598",
        description: "Mix of 11 Herbs Proven to reduce Blood Glucose"
      },
      "Liver Fix": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/lf_2.webp?v=1744809988",
        description: "Supports Liver Wellness, Aids Detoxification"
      },
      "Sugar Defend Pro": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/SDP_2_4fdc364f-3197-4867-9f63-0022dcac2586.webp?v=1744875711",
        description: "Supports Energy Balance, Works Holistically"
      },
      "Vasant Kusmakar Ras": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/VKR.webp?v=1744875711",
        description: "Ayurvedic Formulation, For Daily Vitality"
      },
      "Stress & Sleep": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/S_S_9a0d9003-3f5f-4514-8a5a-4c014b5dea06.webp?v=1744875711",
        description: "Non-Addictive Formula, Promotes Restful Sleep"
      },
      "Chandraprabha Vati": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/CPV_309f6255-286c-4c40-8d44-eea07f5a5e36.webp?v=1744875711",
        description: "Focus on kidney wellness for a balanced lifestyle"
      },
      "Heart Defend Pro": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/HDP_2.webp?v=1744875711",
        description: "Promotes Cardiovascular Well-being"
      },
      "Performance Forever": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/PF_2.webp?v=1744875711",
        description: "Enhances Strength and Energy Levels"
      },
      "Power Gut": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/PG_2_c7332d00-50b9-476e-aeb3-005babd4b95d.webp?v=1744875711",
        description: "Supports Gut Health with Probiotic Formula"
      },
      "HbA1c - Blood Test": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/blood_test.webp?v=1744881342",
        description: "Body Check-Up"
      },
      "Full Body Checkup": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/blood_test.webp?v=1744881342",
        description: "Body Check-Up"
      },
      "Lipid + HbA1c + Liver": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/blood_test.webp?v=1744881342",
        description: "Body Check-Up"
      },
      "Shilajit with Gold": {
        image: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Shilajit_3.webp?v=1744875711",
        description: "Supports Vitality and Muscle Recovery"
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


    // … inside your router, where you build productCardsHtml …
let productCardsHtml = "";
selectedProducts.forEach(product => {
  const details = productDetailsMap[product];
  if (!details) return;

  const condition = conditionMap[product] || "Symptoms Based ";

  productCardsHtml += `
    <div 
      class="product-card" 
      data-product="${product}"
      style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 10px 10px 0;
        margin: 10px 0;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.1), 0 1px 10px rgba(0,0,0,0.15);
        cursor: pointer;
      "
    > 
      <img
        src="${details.image}"
        alt="${product}"
        style="height: 100px; width: auto; object-fit: contain;"
      />
      <div style="flex: 1; margin: 0 10px 0 0;">
        <h2 style="margin:0;font-size:17px;white-space:nowrap;">${product}</h2>
        <p style="margin:0 0 10px;font-size:14px;color:#555;">
          ${details.description}
        </p>
        <hr style="border:none;height:1px;background:#ccc;margin:10px 0;" />
        <span style="font-size:13px;font-weight:bold;color:#333;">${condition}</span>
      </div>
      <img
      class="tag-icon"
        src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_130_2.png?v=1746007801"
        alt="tag"
        style="height:25px;"
        style="height:25px; transition: transform 0.3s;"
      />
    </div>
  `;
});


    // Generate add-ons section based on freebies
    const freebies = consultationDetails.closing?.freebie || [];
    const addOnMap = {
      "Dumbbells": "https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Group_829.webp?v=1745492244",
      "Glucometer +10 strips": "https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Group_830.webp?v=1745492244",
      "Glucometer +25 strips": "https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Group_832.webp?v=1745492244",
      "Diet Plan": "https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Group_828.webp?v=1745492244"
    };
    let addOnsHtml = "";
    if (freebies.length) {
      addOnsHtml += `
        <div class="addons-section">
          <h3 style="font-size:26px;margin-top:30px;margin-bottom:20px;">Free Gift's For You</h3>
          <div class="addons-container">
      `;
      freebies.forEach(item => {
        const imgUrl = addOnMap[item];
        if (imgUrl) {
          addOnsHtml += `
            <div class="addon-item" style="flex:1;padding:10px;text-align:center;">
              <img src="${imgUrl}" alt="${item}" style="max-width:100%;height:auto;box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);"/>
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
          <link rel="icon" href="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam_-_Favicon.png?v=1708245689" />
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
              min-height: 65vh;
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
              min-height: 65vh;
              display: flex;
              align-items: center; 
              text-align: center;
              padding: 20px;
              box-sizing: border-box;
              margin-left: 100px;
            }
            .overlay { 
              color: #fff;
              padding: 20px 20px 20px 0px;
              border-radius: 8px;
              max-width: 90%;  
              text-align: left;
            }
            .dmp-heading{
              font-size: 90px;
              font-weight: 600;
              margin: 0;  
              line-height: 90px;
            }
            .dmp-heading-h1{
              font-size: 60px;
              font-weight: 400;
              margin: 0 auto 0px;
              text-transform: capitalize;
            }
            .duration-badge {
              display: inline-block;
              background-color: #000;
              color: #fff;
              padding: 5px 15px;
              border-radius: 10px;
              margin-top: 10px;
              font-size: 50px;
              text-transform: capitalize;
            }
            
            .additional-image {
              text-align: center;
              margin-top: 20px;
              width: 100%;
            }
            .additional-image img {
              width: 80%;
              height: auto;
            }
            .results-expected {  
              padding: 10px;
              font-family: 'Poppins', sans-serif;
              text-align: center;
            }
            .results-expected-p {
              font-size: 22px;
              color: #5D5D5D !important;
              font-weight: 400;
              margin: 0;
            }
            .results-expected-h3 {
              font-size: 30px; 
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
              width: 47%;
            }
              .goal-section .goal-info {
              display: flex;
              align-items: baseline;
              justify-content: center;
              gap: 10px;
            }
            .goal-section .goal-info p {
              margin: 0;
            }
            .goal-date {
              font-size: 14px;
              font-weight: 500;
              margin: 10px 0 0;
            }
            .goal-hba1c {
              color: #03AD31;
              font-size: 32px;
              margin: 10px 0 0;
              font-weight: 600;
              text-align: center;
            }
            .current-bar-info {
              text-align: right;
              font-size: 14px;
              margin-top: -10px;
              margin-right: 15px;
            }
            .select-option-label {
              margin: 20px 0 10px;
              font-size: 18px;
            }
            .expected-options { 
              display: flex;
              flex-direction: column;
              gap: 10px; 
            }
           .option-box {
            display: flex;
            align-items: center;
            background-color: #f4f4f4;
            padding: 14px 16px;
            border-radius: 8px;
            cursor: pointer;
            text-align: left;
            border: 1px solid transparent;
            transition: border-color 0.2s;
          }
            
            /* Custom radio styles */
            .option-box input[type="radio"] {
              -webkit-appearance: none;
              appearance: none;
              width: 20px;
              height: 20px;
              border: 4px solid #ffffff;
              border-radius: 50%;
              margin-right: 12px;
              position: relative;
              cursor: pointer;
            }

            .option-box input[type="radio"]:checked {
              border-color:rgb(255, 255, 255); 
            }
                
            .option-box:has(input[type="radio"]:checked) {
              border-color: #03AD31; 
              background-color: #03AD31; 
                }

            .option-box input[type="radio"]:checked::after {
              transform: scale(1);
            }

            .option-box input[type="radio"]:checked + span {
              color: #fff;
            }

            /* Hover & focus */
            .option-box:hover {
              border-color: #bbb;
            }
            .option-box input[type="radio"]:focus {
              outline: none;
              box-shadow: 0 0 0 3px rgba(5, 175, 255, 0.3);
            }

            /* Label text */
            .option-box span {
              font-size: 16px;
              color: #333;
            }
            .Your-dce{
              font-size: 32px;
              font-weight: 600;
              color:rgb(0, 0, 0);
              text-align: center;
              text-transform: capitalize;
              margin: 0;
            }
            .Your-dce-sp{
              font-size: 28px;
              font-weight: 400;
              line-height: 30px;
            }
            .customer-dmp-top{
              text-align: left; 
              margin: 0 auto;
              width: 80%;
            }
            .customer-dmp{
              font-size: 25px;
              margin-bottom: 0px;
            }
            .customer-dmp-1{
              margin-top: 0px;
              font-size: 40px;
              color: #543087;
              margin-bottom: 15px;
            }
            .customer-dmp-2{
              background-color: #F4F4F4;
              color: black;
              box-shadow: 0 0 4px 0;
              border-radius: 25px;
              font-size: 18px;
              padding: 5px 20px;
            }
            .Your-dce-d{
              padding: 10px;
            }
              .addons-container { 
              gap: 20px;
            }
             /* Risks section */
            .risks-section {
              margin-top: 0px; 
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
              flex-wrap: nowrap;
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
              scroll-snap-type: x mandatory;
              scroll-behavior: smooth;
            }
              .risks-container::-webkit-scrollbar {
                display: none;
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

             
                 .turning-section-amg {
                  text-align: center;
                  padding: 8px;
                  font-family: 'Poppins', sans-serif;
                }
                .turning-section-amg h2 {
                  margin: 8px 0 40px;
                  font-size: 32px;
                  font-weight: 700;
                  color: #B0B0B0;
                  line-height: 1;
                }
                .subtitle-amg {
                  margin: 0 auto 25px;
                  font-size: 35px;
                  color: #000000;
                  font-weight: 500;
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
                max-width:420px;margin:10px auto;border:1px solid #E0E0E0;
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
                .bottom-section {
                  display: flex;
                  gap: 20px;
                  margin: 20px auto;
                  width: 80%;
                }
                .main-content {
                  flex: 0 0 55%;
                  border: 1px solid #E0E0E0;
                  padding: 15px;
                  border-radius: 10px;
                }
                .sidebar {
                  flex: 0 0 35%;
                }

              .cards-scroll-cpre {
                display: flex;
                justify-content: space-between;
                width: 68%;
                margin: 20px auto;
              }

              .cards-scroll-cpre .card-cpre {
                flex: 1 1 calc((100% / 3) - 10px);
                margin: 0 5px;
              }

              /* Card base */
              .card-cpre {
                background: #fff;
                border-radius: 12px;
                box-shadow: 0 0 4px rgba(0, 0, 0, 0.12);
                padding: 16px; 
                flex-direction: column;
                justify-content: center;
              }

              .card-header-cpre {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 8px;
              }

              .avatar-cpre img {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                border: 2px solid #eee;
                object-fit: cover;
              }

              .user-info-cpre { display: flex; flex-direction: column; }

              .name-cpre {
                font-weight: bold;
                color: #333;
                font-size: 16px;
              }

              .location-cpre {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 13px;
                color: #777;
              }

              .location-cpre img {
                display: inline-block;
              }

              .divider-cpre {
                height: 0.5px;
                background: #C0C0C0;
                margin: 4px 0;
              }

              .stars-cpre span {
                margin-right: 2px;
                font-size: 22px;
              }

              .description-cpre {
                font-size: 14px;
                color: #444;
                line-height: 1.4;
              }

              /* Separator above a vertical list (if used) */
              .main-cpre::before {
                content: '';
                display: block;
                height: 1px;
                width: 90vw;
                background-color: #C0C0C0;
                margin: 5px auto 12px auto;
              }   

              .heading-section-cpreb.main-cpreb {
                text-align: center; 
              }
              .heading-section-cpreb.main-cpreb h1 {
                font-size: 35px;
                color:rgb(0, 0, 0);
                font-weight: 500; 
              }
              

              /* Cards list (vertical) */
              .cards-list-cpreb {
                display: flex;
                flex-direction: column;
                gap: 16px;
                width: 80%;
                margin: 0 auto; 
              }

              /* Card base */
              .card-cpreb {
                background: #fff;
                border-radius: 12px;
                box-shadow: 0 0 4px rgba(0,0,0,0.12);
                padding: 16px;
                display: flex;
                flex-direction: column;
              }
              .card-header-cpreb {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 8px;
              }
              .avatar-cpreb img {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                border: 2px solid #eee;
                object-fit: cover;
              }
              .user-info-cpreb { display: flex; flex-direction: column; }
              .name-cpreb {
                font-weight: bold;
                color: #333;
                font-size: 16px;
              }
              .location-cpreb {
                display: flex;
                align-items: center;
                gap: 4px;
                font-size: 13px;
                color: #777;
              }
              .divider-cpreb {
                height: 0.5px;
                background: #C0C0C0;
                margin: 4px 0;
              }
              .stars-cpreb {
                color: orange;
                font-size: 1.25rem;
                margin-bottom: 8px;
              }
              .stars-cpreb span { margin-right: 2px; }
              .description-cpreb {
                font-size: 14px;
                color: #444;
                line-height: 1.4;
              }

              /* Review images */
              .review-images-cpreb {
                display: flex;
                gap: 10px;
                margin-top: 10px;
              }
              .review-images-cpreb img {
                width: 165px;
                height: 165px;
                object-fit: cover;
                border-radius: 4px;
                border: 1px solid #ccc;
              }

              /* Horizontal scrollable row (if needed) */
              .cards-scroll-cpreb {
                display: flex;
                gap: 10px;
                overflow-x: auto;
                padding-bottom: 8px;
                scroll-snap-type: x mandatory;
                -webkit-overflow-scrolling: touch;
                width: 100%;
                max-width: 1000px;
                margin-bottom: 32px;
              }
              .cards-scroll-cpreb::-webkit-scrollbar {
                height: 6px;
                display: none;
              }
              .cards-scroll-cpreb .card-cpreb {
                flex: 0 0 220px;
                max-width: 324px;
                max-height: 320px;
                margin: 3px;
              }

              /* Separator above a vertical list */
              .main-cpreb::before {
                content: '';
                display: block;
                height: 1px;
                width: 90vw;
                background-color: #C0C0C0;
                margin: 5px auto 12px auto;
              }

              .expert {
                padding-left: 20%;
                padding-right: 20%;
                display: flex;
                flex-direction: column;
                align-items: center;
                font-family: "Poppins", sans-serif;
              }

              /* Heading */
              .heading-section {
                text-align: center;
                max-height: 110px;
              }
              .heading-section h1 {
                font-size: 35px;
                color: #000000;
                font-weight: 500;
                margin: 0;
              }
              .heading-section h2 {
                font-size: 50px;
                color: #C0C0C0;
                font-weight: 600;
                line-height: 1;
                margin: 0;
              }

              /* Expert container */
              .expert-container {
                display: flex;
                align-items: center;
                width: 100%;
                max-width: 1000px;
                margin-top: 20px;
                flex-wrap: wrap;
              }
 
              .expert-left {
                flex: 0 0 200px;
                text-align: center;
              }
              .expert-left .avatar {
                width: 150px;
                height: 150px;
                margin: 0 auto 16px;
                overflow: hidden;
                border-radius: 50%;
                border: 3px solid #ddd;
              }
              .expert-left .avatar img {
                width: 100%;
                height: 100%;
                max-width: 236px;
                max-height: 236px;
                object-fit: cover;
              }
              .expert-details {
                font-size: 16px;
                color: #333;
                line-height: 1.4;
                margin-bottom: 8px;
              }
              .expert-details h3 {
                margin-bottom: 8px;
              }
              .expert-details p {  
                line-height: 10px;
                margin-bottom: 30px;
              }

              /* Right column: longer bio/description */
              .expert-description {
                flex: 1;
                font-size: 15px;
                color: #444;
                line-height: 1.3;
              }

              .expert-details h1 {
                color: #543087; 
                font-size: 30px;               
                line-height: 20px;
                margin-top: -10px;
              }
              .btnn {
                padding: 15px 50px;
                border-radius: 22px;
                cursor: pointer;
                border: none;
                background: #0984E3;
                color: white;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
                margin-top: 20px;
                text-decoration: none;
              }

              .faq-cpreb {
                width: 80%;
                margin: 30px auto;
                padding: 0 20px;
                font-family: "Poppins", sans-serif;
              }
              .faq-heading-cpreb {
                text-align: center;
                font-size: 35px;
                color:rgb(0, 0, 0);
                font-weight: 500;
                margin-bottom: 1.5rem;
              }
                .faq-heading-cpreb-s {
                text-align: center;
                font-size: 40px;
                color: #C0C0C0;
                font-weight: 600;
                margin-bottom: 1.5rem;
              }

              /* Accordion Item */
              .faq-item-cpreb { 
                margin-bottom: 10px;
              }

              /* Question (Summary) */
              .faq-item-cpreb summary {
                list-style: none;
                cursor: pointer;
                position: relative;
                padding-left: 2rem;
                font-size: 18px;
                font-weight: 600;
                padding-bottom: 10px;
                color: #000000;
              }
              .faq-item-cpreb summary::-webkit-details-marker {
                display: none;
              }

              /* Plus icon */
              .faq-item-cpreb summary::before {
                content: "+";
                position: absolute;
                left: 0;
                top: 0;
                font-weight: bold;
                font-size: 1rem; 
                color: #000;
              }

              /* Minus icon when open */
              .faq-item-cpreb[open] summary::before {
                content: "−";
                color: #000;
              }

              /* Answer Text */
              .faq-answer-cpreb {
                margin: 0.5rem 0 1rem 2rem;
                color: #444;
                font-size: 0.95rem;
                line-height: 1.5;
              }

              /* Fade-in Animation */
              @keyframes fadeIn {
                from { opacity: 0; }
                to   { opacity: 1; }
              }
              .faq-item-cpreb[open] .faq-answer-cpreb {
                animation: fadeIn 0.2s ease-in;
              }

              .site-footer {
                background-color: #000;
                color: #fff;
                text-align: center;
                padding: 20px 20px 60px;
                font-family: "Poppins", sans-serif;
                margin-top: 20px;
              }

              .footer-content {
                max-width: 600px;
                margin: 0 auto;
              }
 
              .footer-logo img {
                max-width: 200px;
                width: 100%;
                height: auto;
                margin-bottom: 16px;
              }
 
              .footer-tagline {
                font-size: 1rem;
                opacity: 0.8;
                margin-bottom: 8px;
              }
 
              .footer-cta {
                font-size: 1.5rem;
                font-weight: 600;
                margin: 16px 0;
              }
 
              .footer-copy {
                font-size: 0.875rem;
                opacity: 0.6;
                margin-top: 24px;
              }

              .list-section {
                font-family: "Poppins", sans-serif;
                font-weight: 400;
                font-style: normal;
                width: 80%;
                margin: 0 auto;
                }

                .dropdown-item {
                  border-bottom: 1px solid gray;
                  overflow: hidden;
                }

                .dropdown-item input[type="checkbox"] {
                  display: none;
                }

                .dropdown-item label {
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  padding: 15px 0px;
                  cursor: pointer; 
                  font-size: 23px;
                  color: #000;      
                }

                .dropdown-item label img {
                  width: 18px;
                  height: 18px;
                  transform: rotate(90deg);
                }

                .dropdown-item input[type="checkbox"]:checked + label img {
                  transform: rotate(270deg);
                }

                .dropdown-content {
                  max-height: 0;
                  overflow: hidden;
                  padding: 0 10px;
                }

                .dropdown-item input[type="checkbox"]:checked ~ .dropdown-content {
                  max-height: 500px;
                  padding:  2px 20px 0;
                  margin-top: 0;
                }

                .dropdown-title {
                  font-size: 18px; 
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  color: #000;     
                }

                .dropdown-description {
                  font-size: 15px;
                  color: #515151;
                  margin-top: 2px;
                  font-weight: 400; 
                }

                .dropdown-title img {
                  margin-left: 10px;
                  width: 18px;
                  height: 18px;
                }

                .dropdown-description h3 {
                  font-size: 18px; 
                  color: #000;
                  margin-bottom: 1px;
                  margin-top: 0;
                }

                .dropdown-description p {
                  font-size: 15px;
                  font-weight: 400;
                  color: #515151;
                  margin-bottom: 10px;
                  padding-left: 18px;
                }

                .dmp-heading-span{
                font-size: 15px;
                  font-weight: 400;
                  color:rgb(255, 255, 255);
                }
                .tag-icon.rotated {
                  transform: rotate(180deg);
                }








              @media only screen and (max-width: 767px) {
              .dmp-heading{
                font-size: 42px; 
                line-height: 45px; 
              }
              .dmp-heading-h1{
                font-size: 30px;
                font-weight: 400;
                margin: 0 auto 0px;
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
              display: flex;
                flex-wrap: nowrap;
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                scroll-snap-type: x mandatory;
                scroll-behavior: smooth;
                 scrollbar-width: none; 
                 -ms-overflow-style: none;
              }
                 
              .risk-item {
                scroll-snap-align: start;
              }
                 
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
                .results-expected {  
              text-align: left;
            }
              .goal-section {
              width: 98%;
            }
              .bottom-section {
                  flex-direction: column;
                  width: 98%;
                }
                  .customer-dmp-top{
              text-align: left; 
              margin: 0 auto;
              width: 95%;
            }
              .customer-dmp-1{
              font-size: 23px;
              }
              .customer-dmp-2 { 
                font-size: 14px;
                padding: 5px 10px;
            }
                .main-content { 
                  padding: 10px; 
                }
              .caption-amg {
                font-size: 12px;
              } 
                .cards-scroll-cpre {
                  display: flex;
                  flex-wrap: nowrap;
                  overflow-x: auto;
                  -webkit-overflow-scrolling: touch;
                  scroll-snap-type: x mandatory;
                  scroll-behavior: smooth;
                  scrollbar-width: none;
                  -ms-overflow-style: none;
                  width: 100%;
                  padding-bottom: 8px;
                  gap: 10px;
                  margin-bottom: 32px;
                }
                .cards-scroll-cpre::-webkit-scrollbar {
                  display: none;
                }
                .cards-scroll-cpre .card-cpre {
                  flex: 0 0 310px; 
                  margin: 0;
                }
                  .heading-section-cpreb.main-cpreb {
                    text-align: left; 
                    padding-left: 10px;
                  }
                  .heading-section-cpreb.main-cpreb h1 {
                    font-size: 25px;
                    text-align: center;
                  }
                  .heading-section-cpreb.main-cpreb h2 {
                    font-size: 32px;
                    line-height: 41px;
                  }

                  .review-images-cpreb {
                    gap: 10px;
                    margin-top: 10px;
                  }
                  .review-images-cpreb img {
                    width: 123px;
                    height: 100px;
                  }

                  .cards-scroll-cpreb {
                    flex-wrap: nowrap;
                    scrollbar-width: none;
                    -ms-overflow-style: none;
                    scroll-behavior: smooth;
                  }
                  .cards-scroll-cpreb .card-cpreb {
                    flex: 0 0 340px;
                    max-width: 340px;
                    max-height: 309px;
                    margin: 0;
                  }
                    .additional-image img {
                      width: 98%;
                      height: auto;
                    }
                    .expert-container {
                      flex-direction: column;
                      align-items: center;
                      text-align: center;
                    }
                    .expert-left {
                      flex: none;
                    }
                    .expert-description {
                      margin-top: 24px;
                      max-width: 442px;
                      max-height: 299;
                    }
                    .expert-description {
                      flex: 1;
                      font-size: 14px;
                      line-height: 1.3;
                      padding: 10px;
                    }
                    
                    .btnn {
                      padding: 12px 45px;
                      border-radius: 22px;
                      cursor: pointer;
                      border: none;
                      background: #0984E3;
                      color: white;
                      font-size: 14px;
                      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
                    }
                    .expert{
                        padding: 0;
                    }
                      .cards-list-cpreb { 
                      width: 95%; 
                  }
                      .faq-cpreb {
                      padding: 0 2px;
                      width: 95%;
                    }
                    .faq-heading-cpreb {
                      font-size: 25px;
                      margin-bottom: 1rem;
                    }
                    .faq-item-cpreb summary {
                      font-size: 1rem;
                      padding-left: 1.5rem;
                    }
                    .faq-item-cpreb summary::before {
                      font-size: 0.9rem;
                      left: 0;
                    }
                    .faq-answer-cpreb {
                      margin-left: 1.5rem;
                      font-size: 0.9rem;
                    }

                    .footer-logo img {
                      max-width: 160px;
                    }
                    .footer-cta {
                      font-size: 1.25rem;
                    }

                        .dropdown-description h3 {
                        font-size: 14px;
                        font-weight: 600; 
                        
                      }
                        .heading-section h1 {
                        font-size: 25px; 
                      }

                      .dropdown-description p {
                        font-size: 14px;
                        font-weight: 400;
                      }
                        .subtitle-amg { 
                        font-size: 25px; 
                      }

                      .dropdown-title {
                        font-size: 14px;
                        font-weight: 600;
                      }

                  .dropdown-item img {
                      transform: rotate(90deg);
                    }

                      .dropdown-item label {
                        font-size: 23px;
                        font-weight: 600; 
                      }
                        .list-section { 
                      width: 95%; 
                      }
                      .container { 
                      margin-left: 0px;
                    }
                      .dmp-heading-span {
                        font-size: 14px; 
                    }
                      .heading-section h2 {
                        font-size: 40px; 
                      }

                      .mobile-pay-wrapper { 
                      position: static;
                      width: 100%;
                      transition: none;
                    }
                    .mobile-pay-wrapper.is-fixed { 
                      position: fixed;
                      bottom: 0;
                      left: 0;
                      right: 0;
                      width: 100%;
                      z-index: 999;
                      background-color: white;
                    }
                   
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
        <header style="text-align:center; padding:10px 0;">
          <img
            src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Muditam_Logo-01-01.png?v=1725434339"
            alt="Muditam Logo"
            style="max-height:35px; width:auto;"
          />
        </header>
          <div class="wrapper">
            <div class="container">
              <div class="overlay">
                <h1 class="dmp-heading-h1">${customer.name}'s</h1>   
                <span class="dmp-heading-span">(Age: ${customer.age},${presalesGender})</span> 
                <h2 class="dmp-heading">DIABETES<br> MANAGEMENT<br> PLAN</h2>
                <div class="duration-badge">${consultationDetails.closing && consultationDetails.closing.courseDuration ? consultationDetails.closing.courseDuration : "Not provided"}</div>
              </div>
            </div>
          </div>
          <!-- Additional Image Section -->
          <div class="additional-image">
            <picture>
              <source media="(min-width: 768px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_914.jpg?v=1745648444">
              <source media="(max-width: 767px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_911.jpg?v=1745648443">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_914.jpg?v=1745648444" alt="Additional Visual">
            </picture>
          </div>

          <!-- Results Expected Section -->
          <div class="results-expected">
            <p class="results-expected-p">Results Expected in <span class="results-expected-h3">90 Days</span></p>
          </div>
          <!-- Goal Section -->
          <div class="goal-section">
          <div class="goal-info">
            <p class="goal-date">${goalDateString}</p>
            <p class="goal-hba1c" id="goalHba1cDisplay">${goalHba1c}%</p>
            </div>
            <!-- Dynamic bar image -->
            <div class="goal-pointer-image">
              <img
                id="goalBarImage"
                src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_916.webp?v=1745650473"
                alt="Goal Pointer"
                style="width:90%;height:75px;"
              />
            </div>
            <!-- Current bar info -->
            <div class="current-bar-info">
              <p>${currentDateString}: ${currentHba1c}%</p>
            </div>
            <p class="select-option-label">Select an option to see expected results</p>
            <div class="expected-options">
              <label class="option-box">
                <input
                  type="radio"
                  name="expectedOption"
                  value="only"
                  onchange="updateGoalHba1c(this)"
                />
                <span>Only Supplements</span>
              </label>
              <label class="option-box">
                <input
                  type="radio"
                  name="expectedOption"
                  value="diet"
                  onchange="updateGoalHba1c(this)"
                  checked
                />
                <span>With Diet &amp; Supplements</span>
              </label>
              <label class="option-box">
                <input
                  type="radio"
                  name="expectedOption"
                  value="lifestyle"
                  onchange="updateGoalHba1c(this)"
                />
                <span>With Diet, Lifestyle modifications &amp; Supplements</span>
              </label>
            </div>
          </div>


          <div class="Your-dce-d">
            <p class="Your-dce">${customer.name}'s<br><span class="Your-dce-sp">Diabetes Care Essentials</span></p>
          </div>

          <div class="bottom-section">
        <div class="main-content">
          ${productCardsHtml}
          <!-- placeholder for the expanded detail -->
<div id="expandedProductDetail" style="margin-top: 20px;"></div>

          ${addOnsHtml}

          <div class="risks-section">
            <h3>Risks of High Sugar Levels</h3>
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
                  <img src="https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Kidneys_1.png?v=1745492819" alt="Kidney Damage" />
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
          </div>

          <!-- Payment Breakup Section --> 
          <div class="sidebar">
            <div class="payment-breakup-amg">
              <h3>Payment Breakup</h3>
              <hr class="pb-line" />

              <div class="pb-row">
                <span>Diabetes Management Plan Price:</span>
                <span class="pb-amount">₹${totalPrice}</span>
              </div>
              <hr class="pb-line" />

              <div class="pb-row">
                <span>Special Discount:</span>
                <span class="pb-amount">₹${couponDiscount}</span>
              </div>
              <hr class="pb-line" />

              <div class="pb-row pb-final">
                <span>Final Price:</span>
                <span class="pb-amount">₹${finalPrice}</span>
              </div>
              <hr class="pb-line" />

              <div class="mobile-pay-wrapper">
              <a class="pb-cta pay" href="${payUrl}">
                <p>Pay Now ₹${finalPrice}/–</p>
              </a>
              </div>
            </div>
            </div>
          </div>
        
          <!-- Additional Image Section -->
          <div class="additional-image">
            <picture>
              <source media="(min-width: 768px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_919.webp?v=1745652479">
              <source media="(max-width: 767px)" srcset="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_918.webp?v=1745652478">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_919.webp?v=1745652479" alt="Additional Visual">
            </picture>
          </div>


        <div class="turning-section-amg">
        <p class="subtitle-amg">Why India Trusts Muditam?</p>

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

      <div class="cards-scroll-cpre">
        <div class="card-cpre">
          <div class="card-header-cpre">
            <div class="avatar-cpre">
              <img src="https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Mask_group.png?v=1745497171" alt="">
            </div>
            <div class="user-info-cpre">
              <div class="name-cpre">Priya Sharma</div>
              <div class="location-cpre">
                <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Mumbai
              </div>
            </div>
          </div>
          <div class="divider-cpre"></div>
          <div class="stars-cpre">
            <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
          </div>
          <div class="description-cpre">
            Maine 3 saal se sugar control karne ki koshish ki, par kuch kaam nahi aaya. Muditam ka plan follow karne ke baad 2 mahine mein sugar 280 se 130 tak aaya.Thank you so much!
          </div>
        </div>

        <div class="card-cpre">
          <div class="card-header-cpre">
            <div class="avatar-cpre">
            <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ramesh-sharma.jpg?v=1746005511" alt="">
            </div>
            <div class="user-info-cpre">
              <div class="name-cpre">Rahul Verma</div>
              <div class="location-cpre">
                <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Delhi
              </div>
            </div>
          </div>
          <div class="divider-cpre"></div>
          <div class="stars-cpre">
            <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
          </div>
          <div class="description-cpre">
            Honestly, I wasn’t sure if Ayurveda would work. But with Muditam’s diet plan + supplements, my HbA1c came down from 9.1 to 6.5 in just 4 months.Lifesaver.
          </div>
        </div>

        <div class="card-cpre">
          <div class="card-header-cpre">
            <div class="avatar-cpre">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/f7036841a415a7e3654776f2d62333fb.jpg?v=1746014173" alt="">
            </div>
            <div class="user-info-cpre">
              <div class="name-cpre">Preeti Thakkar</div>
              <div class="location-cpre">
                <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Bengaluru
              </div>
            </div>
          </div>
          <div class="divider-cpre"></div>
          <div class="stars-cpre">
            <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
          </div>
          <div class="description-cpre">
            Customer support is so sweet and helpful. They actually followed up and motivated me every week. This was a very wholesome experience.
          </div>
        </div>
      </div>

        <div class="heading-section-cpreb main-cpreb">
        <h1>50,000+ Happy Customers</h1> 
        </div>

        <div class="cards-list-cpreb">
          <div class="card-cpreb">
            <div class="card-header-cpreb">
              <div class="avatar-cpreb">
                <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Ramesh-bkgrnd.webp?v=1746005511" alt="">
              </div>
              <div class="user-info-cpreb">
                <div class="name-cpreb">Rajesh Aggarwal</div>
                <div class="location-cpreb">
                  <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Ghaziabad
                </div>
              </div>
            </div>
            <div class="divider-cpreb"></div>
            <div class="stars-cpreb">
              <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
            </div>
            <div class="description-cpreb">
              2 saal se sugar control nahi ho rahi thi. Fasting ab  roz 100 ke aas-paas hai. Karela Jamun Fizz ne kamaal kar diya.
            </div>
            <div class="review-images-cpreb">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_2025_04_30T13_40_02_784Z.png?v=1746076534" alt="Customer Photo">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_2025_05_01T06_36_10_887Z.png?v=1746081456" alt="Customer Photo">
            </div>
          </div>

          <div class="card-cpreb">
            <div class="card-header-cpreb">
              <div class="avatar-cpreb">
                <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/INnZycvFWeBbT13XZGCwPHOqQ7fQV884lRiPniw2Q0CJ15Q17Q7dMUB.jpg?v=1746005511" alt="">
              </div>
              <div class="user-info-cpreb">
                <div class="name-cpreb">Ramesh Joshi</div>
                <div class="location-cpreb">
                  <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Ahmedabad
                </div>
              </div>
            </div>
            <div class="divider-cpreb"></div>
            <div class="stars-cpreb">
              <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
            </div>
            <div class="description-cpreb">
              Sugar 300 se 127 aa gaya within 2 months. No allopathy, just Muditam. Feeling light, energetic, and finally hopeful.
            </div>
            <div class="review-images-cpreb">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/ChatGPT_Image_Apr_30_2025_03_05_05_PM.webp?v=1746005811" alt="Customer Photo"> 
            </div>
          </div>

          <div class="card-cpreb">
            <div class="card-header-cpreb">
              <div class="avatar-cpreb">
                <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1552294645472.jpg?v=1746005554" alt="">
              </div>
              <div class="user-info-cpreb">
                <div class="name-cpreb">Aarav Bansal</div>
                <div class="location-cpreb">
                  <img height="12" width="12" src="https://img.icons8.com/ios/50/marker--v1.png" alt="marker"/> Noida
                </div>
              </div>
            </div>
            <div class="divider-cpreb"></div>
            <div class="stars-cpreb">
              <span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span><span>&#9733;</span>
            </div>
            <div class="description-cpreb">
              Phle mujhe Sugar bohot high rhti thi kuch kha bhi nhi pata tha, Muditam ki salah se maine Karela Jamun Fizz liya phle mahine se mujhe frk dikhne lga.
            </div>
            <div class="review-images-cpreb">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/IMG_2294.heic?v=1746076533" alt="Customer Photo">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/IMG_5742_Medium_41c12738-7ddc-44b1-b9a1-a5b0c97a7501.jpg?v=1734173391" alt="Customer Photo">
              <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/IMG_5744_Medium_3134c226-ff4a-4d40-a45d-f1de1571a218.jpg?v=1734173392" alt="Customer Photos">
            </div>
          </div>
        </div>

        <section class="faq-cpreb">
        <h2 class="faq-heading-cpreb">Frequently Asked Questions</h2>

        <details class="faq-item-cpreb">
          <summary class="faq-question-cpreb">
            How is Muditam different from other diabetes or Ayurvedic brands?
          </summary>
          <p class="faq-answer-cpreb">
            We don’t just sell supplements. Muditam follows the Triwellness Approach — Ayurveda + Nutrition + Modern Science.
            Along with natural supplements, you get a personalised diet plan, expert doctor consultation,
            and support from a Diabetes Coach.
          </p>
        </details>

        <details class="faq-item-cpreb">
          <summary class="faq-question-cpreb">
            How do I get started? What’s the process?
          </summary>
          <p class="faq-answer-cpreb">
            It’s super simple:
            <br/>✅ You share your sugar levels, lifestyle & goals
            <br/>✅ Our experts create a customised kit
            <br/>✅ You get doctor consultation, diet plan, supplements & daily support
            <br/>✅ We monitor your progress and guide you step-by-step
          </p>
        </details>

        <details class="faq-item-cpreb">
          <summary class="faq-question-cpreb">
            Do I have to take these supplements lifelong?
          </summary>
          <p class="faq-answer-cpreb">
            No. Once your sugar levels stabilize and your lifestyle improves, our team helps you taper off
            supplements naturally and safely. Our goal is health freedom, not dependency.
          </p>
        </details>

        <details class="faq-item-cpreb">
          <summary class="faq-question-cpreb">
            Are Muditam products safe? Any side effects?
          </summary>
          <p class="faq-answer-cpreb">
            Absolutely. Our products are made from pure Ayurvedic ingredients, with no chemicals or steroids.
            They are tested for quality and backed by 50,000+ success stories. We’ve seen zero side effects.
          </p>
        </details>

        <details class="faq-item-cpreb">
          <summary class="faq-question-cpreb">
            How long will it take to see results?
          </summary>
          <p class="faq-answer-cpreb">
            Most users report improvements like better sugar control, more energy, and reduced cravings in 3–4 weeks.
            Full reversal may take 3–6 months, depending on your condition. We’re with you at every step.
          </p>
        </details>
      </section>
      
      <section class="expert">
        <div class="heading-section">
          <h1>Know Your Expert</h1>
          
        </div>

        <div class="expert-container">
          <div class="expert-left">
            <div class="avatar">
              <img src="https://cdn.shopify.com/s/files/1/0929/2323/2544/files/Mansvi_Ahuja.webp?v=1738855346" alt="Expert Avatar">
            </div>
            <div class="expert-details">
              <p>Hi <strong>${customer.name}</strong>, This is</p>
              <h1>MANSVI</h1>
              <p>Diabetes Expert</p>
              <!-- Button below the expert details and aligned left on large screens -->
        <a href="tel:8989174741" class="btnn"><b>Call Now</b></a>
            </div>
          </div>
          <div class="expert-description">
            I’ve helped 5,960+ people manage their Type 2 Diabetes naturally and safely.</br></br>
            With over 5 years of experience, I specialise in helping people manage blood sugar levels, cholesterol, and lifestyle-related health concerns using a blend of Ayurveda and Functional Nutrition. I work closely with each person to personalise their plan — guiding them step-by-step with supplements, diet changes, and lifestyle support.</br>
            </br>You're not alone in this — I’ll be with you throughout the journey
          </div>
        </div>
      </section>

      <div class="list-section">
    <div class="dropdown-item">
      <input type="checkbox" id="item1">
      <label for="item1">
        Payment Options:
        <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_130.png?v=1744809988" alt="Arrow Icon" />
      </label>
      <div class="dropdown-content">
        <div class="dropdown-description"> 
          <h3>1. Prepaid</h3>
          <p>Make the full payment online before dispatch. Fast and hassle-free delivery.</p>
          <h3>2. Cash on Delivery</h3>
          <p>Want to pay at delivery? Connect with your expert to activate COD for your order. Note: Complete COD is not available where blood test is included.</p>
        </div>
      </div>
    </div>

    <div class="dropdown-item">
      <input type="checkbox" id="item2">
      <label for="item2">
        Disclaimer:
        <img src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_130.png?v=1744809988" alt="Arrow Icon" />
      </label>
      <div class="dropdown-content">
        <div class="dropdown-description">
          <p>1. If you choose partial payment and go ahead with the blood test, the remaining blood test amount must be paid—even if the rest of the order is cancelled.</p>
          <p>2. A 100% refund on your product order amount is available only before your order is dispatched.</p>
          <p>3. Expected results are based on completing the 90-day kit, regardless of the number of days shared in your quotation.</p>
          <p>4. Results may vary depending on your existing complications, other health conditions, and how well you follow the suggested diet and lifestyle.</p>
        </div>
      </div>
    </div>
  </div>

      <footer class="site-footer">
        <div class="footer-content">
          <div class="footer-logo">
            <img
              src="https://cdn.shopify.com/s/files/1/0734/7155/7942/files/new_logo_orange_leaf_1_4e0e0f89-08a5-4264-9d2b-0cfe9535d553.png?v=1727508866"
              alt="Muditam Logo"
            />
          </div>
          <p class="footer-tagline">
            Proven by Science. Rooted in Ayurveda. Trusted by 50,000+.
          </p>
          <h2 class="footer-cta">Now it’s your turn.</h2>
          <p class="footer-copy">
            Copyright © 2025 Muditam Ayurveda Pvt. Ltd.
          </p>
        </div>
      </footer>

      <script> 
        const currentHba1c = ${presalesHba1c};
 
        function updateGoalHba1c(selected) {
          // uncheck all so we can re-style them
          document.querySelectorAll('input[name="expectedOption"]')
            .forEach(box => box.checked = false);
          selected.checked = true;

          let newGoal, barImage = document.getElementById("goalBarImage");
          if (selected.value === "only") {
            newGoal = currentHba1c - 0.8;
            barImage.src = "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_917.webp?v=1745650473";
          } else if (selected.value === "diet") {
            newGoal = currentHba1c - 1.5;
            barImage.src = "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_916.webp?v=1745650473";
          } else if (selected.value === "lifestyle") {
            newGoal = currentHba1c - 2.5;
            barImage.src = "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/Group_915.webp?v=1745650473";
          }

          document.getElementById("goalHba1cDisplay")
                  .textContent = newGoal.toFixed(1) + "%";
        }
        // make it callable from inline handlers
        window.updateGoalHba1c = updateGoalHba1c;
 
        document.addEventListener("DOMContentLoaded", () => {
          const defaultOpt = document.querySelector('input[name="expectedOption"]:checked');
          if (defaultOpt) updateGoalHba1c(defaultOpt);
        });
      </script>
 
      <script>
        document.addEventListener("DOMContentLoaded", () => {
          const payWrapper = document.querySelector(".mobile-pay-wrapper");
          // When the wrapper’s top edge is at or above the bottom of the viewport,
          // add the .is-fixed class; remove it when it scrolls back up.
          window.addEventListener("scroll", () => {
            const rect = payWrapper.getBoundingClientRect();
            if (rect.top <= window.innerHeight) {
              payWrapper.classList.add("is-fixed");
            } else {
              payWrapper.classList.remove("is-fixed");
            }
          });
        });
      </script>

          <script>
            document.addEventListener("DOMContentLoaded", () => {
               

              // 2) Expanded-detail data for each product 
              const expandedDetails = {
                "Karela Jamun Fizz": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/5_52d21a25-221b-488b-b9cf-381cd8b2485e.webp?v=1745926849",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/4_18ec86f1-e1f1-41e5-af33-f765f92c0ffa.webp?v=1745926849"
                },
                "Liver Fix": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/3_d1495f7b-a13c-4f41-9867-5cd17f1692e4.webp?v=1745669315",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/8_63af8b3f-5cae-43c4-95b9-9519f1daaac2.webp?v=1745669313"
                },
                "Sugar Defend Pro": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_69b3b8f9-c6b4-462d-b555-50ccf5a9e6ee.webp?v=1739770331",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_7.png?v=1746008387"
                },
                "Vasant Kusmakar Ras": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/3_bb30e34f-b58b-4a8a-8aaa-a3a4f7b044ff.webp?v=1739627631",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_8.png?v=1746008512"
                },
                "Stress & Sleep": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_675f8485-aa3d-4f84-84e2-3462be51b6f7.webp?v=1739626378",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_10.png?v=1746009253"
                },
                "Chandraprabha Vati": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_d7874463-a826-4882-b7e3-916928e5f44b.webp?v=1739626540",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_11.png?v=1746009383"
                },
                "Power Gut": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_839803f1-be6a-4e61-b515-26fef8d9c24d.webp?v=1742451985",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/2_7245a59e-0aa2-4d9b-8898-fe4e11b9dd42.webp?v=1742451985"
                },
                "Heart Defend Pro": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_7cfc10e3-2316-43bf-8c83-01ff166a6b32.webp?v=1739626227",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_12.png?v=1746009769"
                },
                "Performance Forever": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/1_65938fe6-c662-4f81-8b1c-ecb685f32565.webp?v=1739626055",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/image_13.png?v=1746009984"
                },
                "Shilajit with Gold": {
                  firstImage:  "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/3_93373f2d-4618-4852-9292-1c6e098269c6.webp?v=1735212913",
                  secondImage: "https://cdn.shopify.com/s/files/1/0734/7155/7942/files/8_2e0bf5d6-01a3-4d2e-8765-26756e96d2d9.webp?v=1735212913"
                }
              };

              // 3) Attach click-to-expand behavior
              document.querySelectorAll(".product-card").forEach(card => {
                const tagImg = card.querySelector(".tag-icon");

                card.addEventListener("click", () => {

                  const next = card.nextElementSibling;
                    if (next && next.classList.contains("expanded-detail")) {
                      tagImg.classList.remove("rotated");
                      next.remove();
                      return;
                    }

                  document.querySelectorAll(".expanded-detail").forEach(panel => {
                    const prevCard = panel.previousElementSibling;
                    prevCard.querySelector(".tag-icon")?.classList.remove("rotated");
                    panel.remove();
                  });

                  tagImg.classList.add("rotated");
                  const name = card.dataset.product;
                  const info = expandedDetails[name];
                  if (!info) return;

                  // Build a new detail panel using DOM API
                  const detailEl = document.createElement("div");
                  detailEl.className = "expanded-detail";
                  detailEl.dataset.product = name;
                  detailEl.style.cssText = "background:#f9f9f9;padding:20px;border-radius:8px;margin-top:10px;";

                  // first image
                  const img1 = document.createElement("img");
                  img1.src = info.firstImage;
                  img1.alt = name;
                  img1.style.cssText = "max-width:100%;display:block;margin:0 auto 10px;";
                  detailEl.appendChild(img1);

                 

                  // second image
                  const img2 = document.createElement("img");
                  img2.src = info.secondImage;
                  img2.alt = name + " detail";
                  img2.style.cssText = "max-width:100%;display:block;margin:0 auto;";
                  detailEl.appendChild(img2);

                  // insert it immediately after the clicked card
                  card.parentNode.insertBefore(detailEl, card.nextSibling);
                  detailEl.scrollIntoView({ behavior: "smooth" });
                });
              });
            });
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
