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
          background-image: url('https://media-hosting.imagekit.io/c3f763e470e84463/ChatGPT%20Image%20Apr%2011,%202025,%2004_42_09%20PM%201.jpg?Expires=1839067025&Key-Pair-Id=K2ZIVPTIP2VGHC&Signature=QFkulw9OYE53koFJWPb0jaP3vR0bkefVYkyGWIhPUPCfG8Zj2i0~BOCr26GrXPN52lHJxNiufuWKsQ948TvWp01ABv-ZzKEfcH2vlxZfR6HNjaNzJc2TmQTs1Bgv~SVc8F0cNACI3BPnEfZMgasijhiqOCHpzKlQ8LauvwKb~O94Vhl2B0gFDIjPB7hLTuyIdEOVbqwUzHcuHlJel3~hw0dQBjWz2bCN7g6xOZ61bGJ3ngDSdjc5YTc9nmQSqaMppJAjT1so7tdiusEvlIp7CE88K4fozrYXvd3cav3n~s-yo86hT5WDAaDt~wSjyi5IXaXKCzRM3UAgcrk66ZyrbA__');
        }
      }
      /* Mobile background image */
      @media only screen and (max-width: 768px) {
        .background-container {
          background-image: url('https://media-hosting.imagekit.io/41dcc84c21f74b1c/ChatGPT%20Image%20Apr%2011,%202025,%2012_36_24%20PM%201.png?Expires=1839067086&Key-Pair-Id=K2ZIVPTIP2VGHC&Signature=PCVSAr1rGhr9oKOlXJNG~LzwyBMZT0IHamjHtGLHBKFJVnYT5MhE7nM7vRVNibBygk3DYZ0K4xJrBgAIr2zMPqhr2ubt8NzNY8AJvxdD5kDPHybcAFjl0CGchOYIms0Mvz-WLm-1oEtf1n4i3hRTj0RUE02saciwRdQok32xqetm7C2KRUxgPrYKTlLvVD3vO5oPHDSBq-FYPDBZ5hWaVrHxlr6dmKGNEgQGcAVkrP04KXZvVsEU3i7U6hnEvWLYhh5OwTCa8CYmw9V~5ZwQ7mt5DAtjL2ckzArsmbXfXwRmiOJy1VA9GdFI~TANXf6DzDT5NX7zXrKYE4DIZjVlrg__');
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