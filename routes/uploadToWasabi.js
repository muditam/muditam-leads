// routes/uploadToWasabi.js
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const requireSession = require('../middleware/requireSession');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

// Initialize Wasabi S3 client
const wasabi = new AWS.S3({
  endpoint: process.env.WASABI_ENDPOINT,
  accessKeyId: process.env.WASABI_ACCESS_KEY,
  secretAccessKey: process.env.WASABI_SECRET_KEY,
  region: process.env.WASABI_REGION,
});

const PUBLIC_BASE =
  String(process.env.WASABI_PUBLIC_BASE_URL || '').replace(/\/+$/, '') || null;
const DEFAULT_PREFIX = String(process.env.IMAGE_MIGRATION_PREFIX || 'diet-images')
  .trim()
  .replace(/^\/+|\/+$/g, '');

function normalizeExt(ext) {
  const e = String(ext || '').toLowerCase();
  const valid = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
  return valid.has(e) ? e : '.jpg';
}

function extFromContentType(contentType = '') {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return '.jpg';
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('image/gif')) return '.gif';
  return '.jpg';
}

function sanitizeBaseName(fileName = '') {
  return String(fileName)
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function buildKey({ originalName, prefix = DEFAULT_PREFIX, deterministic = false }) {
  const safePrefix = String(prefix || DEFAULT_PREFIX)
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '_');

  const parsedName = path.basename(String(originalName || '').trim() || 'image.jpg');
  const ext = normalizeExt(path.extname(parsedName));
  const baseName = sanitizeBaseName(parsedName) || 'image';
  const unique = deterministic ? '' : `-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const key = `${safePrefix}/${baseName}${unique}${ext}`;

  return { key, ext };
}

function requireUploadApiKey(req, res, next) {
  const required = String(process.env.IMAGE_MIGRATION_API_KEY || '').trim();
  if (!required) return next();

  const headerKey = String(req.headers['x-api-key'] || '').trim();
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (headerKey === required || bearerToken === required) return next();

  return res.status(401).json({ message: 'Unauthorized: invalid API key' });
}

async function uploadToWasabi({ buffer, key, contentType }) {
  const params = {
    Bucket: process.env.WASABI_BUCKET,
    Key: key,
    Body: buffer,
    ACL: 'public-read',
    ContentType: contentType || 'application/octet-stream',
  };

  const data = await wasabi.upload(params).promise();
  const url = PUBLIC_BASE ? `${PUBLIC_BASE}/${encodeURI(key)}` : data.Location;

  return { url, key };
}

// Route: POST /api/upload-to-wasabi
router.post('/api/upload-to-wasabi', requireUploadApiKey, upload.array('images'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded.' });
    }

    const uploadedUrls = [];
    const prefix = String(req.body.prefix || DEFAULT_PREFIX);
    const deterministic = String(req.body.deterministic || '').toLowerCase() === 'true';

    for (const file of req.files) {
      const { key } = buildKey({
        originalName: file.originalname,
        prefix,
        deterministic,
      });
      const data = await uploadToWasabi({
        buffer: file.buffer,
        key,
        contentType: file.mimetype,
      });
      uploadedUrls.push({
        url: data.url,
        key: data.key,
        originalName: file.originalname,
      });
    }

    res.status(200).json({ message: 'Upload successful', uploadedFiles: uploadedUrls });
  } catch (error) {
    console.error('Error uploading to Wasabi:', error);
    res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// Route: POST /api/upload-image
// Multipart form-data:
// - file: image file (single)
// - fileName (optional): use this name for deterministic key
// - prefix (optional): folder path in bucket
router.post('/api/upload-image', requireUploadApiKey, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded. Use "file" field.' });
    }

    const fileName = String(req.body.fileName || req.file.originalname || 'image.jpg').trim();
    const prefix = String(req.body.prefix || DEFAULT_PREFIX);
    const deterministic = String(req.body.deterministic || 'true').toLowerCase() !== 'false';

    const { key } = buildKey({
      originalName: fileName,
      prefix,
      deterministic,
    });

    const uploaded = await uploadToWasabi({
      buffer: req.file.buffer,
      key,
      contentType: req.file.mimetype,
    });

    return res.status(200).json({
      message: 'Upload successful',
      url: uploaded.url,
      key: uploaded.key,
    });
  } catch (error) {
    console.error('Error in /api/upload-image:', error);
    return res.status(500).json({ message: 'Upload failed', error: error.message });
  }
});

// JSON body:
// - sourceUrl: remote image URL
// - fileName (optional): deterministic name (e.g. 050.jpg)
// - prefix (optional): folder path in bucket
async function uploadImageFromUrlHandler(req, res) {
  try {
    const sourceUrl = String(req.body?.sourceUrl || '').trim();
    if (!sourceUrl) {
      return res.status(400).json({ message: 'sourceUrl is required' });
    }

    const urlObj = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return res.status(400).json({ message: 'sourceUrl must be http/https' });
    }

    const response = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = String(response.headers['content-type'] || 'image/jpeg');
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(400).json({ message: `URL did not return an image. content-type=${contentType}` });
    }

    const fallbackFromUrl = path.basename(urlObj.pathname) || 'image.jpg';
    const requestedFile = String(req.body?.fileName || fallbackFromUrl).trim();
    const extFromReq = path.extname(requestedFile);
    const normalizedRequested =
      sanitizeBaseName(requestedFile) +
      normalizeExt(extFromReq || extFromContentType(contentType));

    const prefix = String(req.body?.prefix || DEFAULT_PREFIX);
    const deterministic = String(req.body?.deterministic || 'true').toLowerCase() !== 'false';
    const { key } = buildKey({
      originalName: normalizedRequested,
      prefix,
      deterministic,
    });

    const uploaded = await uploadToWasabi({
      buffer: Buffer.from(response.data),
      key,
      contentType,
    });

    return res.status(200).json({
      message: 'Upload successful',
      sourceUrl,
      url: uploaded.url,
      key: uploaded.key,
    });
  } catch (error) {
    console.error('Error in /api/upload-image-from-url:', error);
    return res.status(500).json({ message: 'Upload failed', error: error.message });
  }
}

// Public/API-key route (for scripts/automation)
router.post('/api/upload-image-from-url', requireUploadApiKey, uploadImageFromUrlHandler);

// Session route (for internal frontend users)
router.post('/api/diet-image-migration/upload-from-url', requireSession, uploadImageFromUrlHandler);

module.exports = router;
 
