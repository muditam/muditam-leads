const express = require("express");
const router = express.Router();
const AWS = require("aws-sdk");

console.log("STEP 3: Testing AWS Wasabi init...");

try {
  const s3 = new AWS.S3({
    endpoint: process.env.WASABI_ENDPOINT,
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY,
    region: process.env.WASABI_REGION,
    s3ForcePathStyle: true,
  });

  console.log("AWS S3 initialized OK");
} catch (err) {
  console.error("AWS INIT ERROR:", err);
}

router.get("/", (req, res) => {
  res.send("STEP 3 OK");
});

module.exports = router;
