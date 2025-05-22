// routes/uploadToWasabi.js
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const AWS = require('aws-sdk');
const path = require('path');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Initialize Wasabi S3 client
const wasabi = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region: process.env.WASABI_REGION,
});

// Route: POST /api/upload-to-wasabi
router.post('/api/upload-to-wasabi', upload.array('images'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded.' });
    }

    const uploadedUrls = [];

    for (const file of req.files) {
      const fileContent = fs.readFileSync(file.path);
      const fileExt = path.extname(file.originalname);
      const fileName = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${fileExt}`;

      const params = {
        Bucket: process.env.WASABI_BUCKET,
        Key: fileName,
        Body: fileContent,
        ACL: 'public-read',
        ContentType: file.mimetype,
      };

      const data = await wasabi.upload(params).promise();

      // Delete the temp file from local uploads folder
      fs.unlinkSync(file.path);

      const signedUrl = wasabi.getSignedUrl('getObject', {
        Bucket: process.env.WASABI_BUCKET,
        Key: fileName,
        Expires: 60 * 60 * 24 * 7, // valid for 1 hour
      });

      uploadedUrls.push({
        url: signedUrl,
        key: fileName,
      });
    }

    res.status(200).json({ message: 'Upload successful', uploadedFiles: uploadedUrls });
  } catch (error) {
    console.error('Error uploading to Wasabi:', error);
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

module.exports = router;
 