const express = require("express");
const router = express.Router();
const multer = require("multer");

console.log("STEP 4: Testing multer...");

let upload;
try {
  upload = multer({ storage: multer.memoryStorage() });
  console.log("Multer initialized OK");
} catch (err) {
  console.error("Multer init error:", err);
}

router.post("/test-upload", upload.single("file"), (req, res) => {
  console.log("Upload endpoint hit");
  res.json({ message: "File received", size: req.file?.size || 0 });
});

router.get("/", (req, res) => {
  res.send("STEP 4 OK");
});

module.exports = router;
