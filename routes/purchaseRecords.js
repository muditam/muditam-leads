const express = require("express");
const router = express.Router();

console.log("STEP 5: Testing XLSX import...");

try {
  const XLSX = require("xlsx");
  console.log("XLSX module loaded OK");
} catch (err) {
  console.error("XLSX import error:", err);
}

router.get("/", (req, res) => {
  res.send("STEP 5 OK");
});

module.exports = router;
