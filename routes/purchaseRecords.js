const express = require("express");
const router = express.Router();

console.log("STEP 2: Testing Mongoose models...");

try {
  const PurchaseRecord = require("../models/PurchaseRecord");
  console.log("PurchaseRecord model loaded OK");
} catch (err) {
  console.error("PurchaseRecord model error:", err);
}

try {
  const Vendor = require("../models/Vendor");
  console.log("Vendor model loaded OK");
} catch (err) {
  console.error("Vendor model error:", err);
}

router.get("/", (req, res) => {
  res.send("STEP 2 OK");
});

module.exports = router;
