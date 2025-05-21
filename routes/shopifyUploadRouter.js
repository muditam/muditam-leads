const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const path = require("path");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const GRAPHQL_ENDPOINT = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-01/graphql.json`;

if (!SHOPIFY_STORE_NAME || !SHOPIFY_ACCESS_TOKEN) {
  throw new Error("Missing SHOPIFY credentials");
}

router.post("/api/upload-to-shopify", upload.array("images"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No images provided in the request." });
    }

    const uploadedFiles = [];

    for (const file of req.files) {
      try {
        // Step 1: Ask Shopify for a staged upload
        const stagedUploadResponse = await axios.post(
          GRAPHQL_ENDPOINT,
          {
            query: `
              mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
                stagedUploadsCreate(input: $input) {
                  stagedTargets {
                    url
                    resourceUrl
                    parameters {
                      name
                      value
                    }
                  }
                }
              }
            `,
            variables: {
              input: [
                {
                  filename: file.originalname,
                  mimeType: file.mimetype,
                  resource: "FILE",
                  fileSize: fs.statSync(file.path).size,
                },
              ],
            },
          },
          {
            headers: {
              "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
              "Content-Type": "application/json",
            },
          }
        );

        const target = stagedUploadResponse.data.data.stagedUploadsCreate.stagedTargets[0];

        // Step 2: Upload to S3 using the staged URL and parameters
        const form = new FormData();
        for (const param of target.parameters) {
          form.append(param.name, param.value);
        }
        form.append("file", fs.createReadStream(file.path));

        await axios.post(target.url, form, {
          headers: form.getHeaders(),
        });

        // Add uploaded file info
        uploadedFiles.push({
          url: target.resourceUrl,
          filename: file.originalname,
          date: new Date(),
        });
      } catch (innerError) {
        console.error(`Upload failed for file ${file.originalname}:`, innerError.response?.data || innerError.message);
      } finally {
        fs.unlink(file.path, (err) => {
          if (err) console.warn(`Failed to delete temp file ${file.path}:`, err.message);
        });
      }
    }

    if (uploadedFiles.length === 0) {
      return res.status(500).json({ message: "None of the files could be uploaded to Shopify." });
    }

    res.json(uploadedFiles);
  } catch (error) {
    console.error("Unexpected error:", error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to upload images to Shopify",
      error: error.response?.data?.errors || error.message,
    });
  }
});

module.exports = router;
