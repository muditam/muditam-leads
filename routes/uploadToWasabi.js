// routes/uploadToWasabi.js
require('dotenv').config();


const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const requireSession = require('../middleware/requireSession');
const FoodByCat = require('../models/FoodByCat');
const FoodItem = require('../models/FoodItem');
const FoodRecipe = require('../models/FoodRecipe');
const HomeBased = require('../models/HomeBased');
const Packaged = require('../models/Packaged');


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


const COLLECTION_CONFIGS = {
 food_by_cat: {
   model: FoodByCat,
   idField: '_id',
   helperColumns: ['New_Image_ID', 'NewBrandLogo'],
 },
 food_items: {
   model: FoodItem,
   idField: 'code',
   helperColumns: ['New_Image_ID'],
 },
 food_recipes: {
   model: FoodRecipe,
   idField: 'code',
   helperColumns: ['New_Image_ID'],
   insertRows: true,
   allowReplaceCollection: true,
 },
 homeBased: {
   model: HomeBased,
   idField: '_id',
   helperColumns: ['New_Image_ID'],
 },
 Packaged: {
   model: Packaged,
   idField: '_id',
   helperColumns: ['New_Image_ID', 'NewBrandLogo'],
 },
};


function buildIdentityFilters(idField, rawId) {
 const filters = [{ [idField]: rawId }];
 const asNumber = Number(rawId);
 if (!Number.isNaN(asNumber)) filters.push({ [idField]: asNumber });
 if (idField === '_id' && mongoose.Types.ObjectId.isValid(rawId)) {
   filters.push({ _id: new mongoose.Types.ObjectId(rawId) });
 }
 return { filters, asNumber };
}


function resolveIdentityValue({ idField, rawId, incomingRow, existingId, asNumber }) {
 if (existingId !== undefined) return existingId;
 if (incomingRow?.[idField] !== undefined && incomingRow?.[idField] !== '') {
   return incomingRow[idField];
 }
 if (!Number.isNaN(asNumber)) return asNumber;
 if (idField === '_id' && mongoose.Types.ObjectId.isValid(rawId)) {
   return new mongoose.Types.ObjectId(rawId);
 }
 return rawId;
}


// Push reviewed image-link updates to DB.
// Body:
// {
//   collectionName?: "food_by_cat" | "food_items" | "food_recipes" | "homeBased" | "Packaged",
//   replaceCollection?: boolean,
//   batchIndex?: number,
//   rows: [{ _id?: "50", code?: "F001", row?: {...}, update?: {...} }]
// }
router.post('/api/diet-image-migration/push-to-db', requireUploadApiKey, async (req, res) => {
 try {
   const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
   const collectionName = String(req.body?.collectionName || 'food_by_cat').trim();
   const batchIndex = Number(req.body?.batchIndex || 0);
   const replaceCollection = req.body?.replaceCollection === true;
   const config = COLLECTION_CONFIGS[collectionName];


   if (!rows.length) {
     return res.status(400).json({ ok: false, message: 'rows array is required' });
   }
   if (!config) {
     return res.status(400).json({
       ok: false,
       message: `Unsupported collectionName. Allowed values: ${Object.keys(COLLECTION_CONFIGS).join(', ')}`,
     });
   }


   let matched = 0;
   let modified = 0;
   let created = 0;
   let deletedBeforeInsert = 0;
   const notFound = [];
   const errors = [];


   if (config.insertRows && replaceCollection && batchIndex === 0) {
     if (!config.allowReplaceCollection) {
       return res.status(400).json({
         ok: false,
         message: `${collectionName} does not allow replaceCollection`,
       });
     }
     const deleteResult = await config.model.deleteMany({});
     deletedBeforeInsert = Number(deleteResult.deletedCount || 0);
   }


   for (const row of rows) {
     const rawId = String(row?.[config.idField] ?? row?._id ?? '').trim();
     const incomingRow = row?.row && typeof row.row === 'object' ? row.row : null;
     const update = row?.update && typeof row.update === 'object' ? row.update : null;
     const fullRowPayload = incomingRow || update;


     if (!rawId || !fullRowPayload || !Object.keys(fullRowPayload).length) {
       errors.push({ _id: rawId || '', error: 'Invalid row payload' });
       continue;
     }


     const nextRow = { ...fullRowPayload };
     // Keep migration helper columns out of persisted record.
     config.helperColumns.forEach((column) => {
       delete nextRow[column];
     });


     const { filters: filterOptions, asNumber } = buildIdentityFilters(config.idField, rawId);


     try {
       const replacementDoc = { ...nextRow };


       if (config.insertRows) {
         replacementDoc[config.idField] = resolveIdentityValue({
           idField: config.idField,
           rawId,
           incomingRow: nextRow,
           asNumber,
         });
         await config.model.create(replacementDoc);
         created += 1;
         modified += 1;
       } else {
         const existing = await config.model.findOne({ $or: filterOptions }).lean();


         // Build the exact document shape to persist from sheet row.
         // If doc exists, preserve existing identity type; otherwise derive from incoming row/raw id.
         replacementDoc[config.idField] = resolveIdentityValue({
           idField: config.idField,
           rawId,
           incomingRow: nextRow,
           existingId: existing?.[config.idField],
           asNumber,
         });


         if (existing?.[config.idField] !== undefined) {
           const result = await config.model.replaceOne(
             { [config.idField]: existing[config.idField] },
             replacementDoc
           );
           matched += Number(result.matchedCount || 0);
           modified += Number(result.modifiedCount || 0);
         } else {
           await config.model.create(replacementDoc);
           created += 1;
           modified += 1;
           notFound.push(rawId);
         }
       }
     } catch (error) {
       errors.push({ _id: rawId, error: error.message || 'Update failed' });
     }
   }


   return res.status(200).json({
     ok: true,
     collectionName,
     total: rows.length,
     matched,
     modified,
     created,
     deletedBeforeInsert,
     notFound,
     errors,
   });
 } catch (error) {
   console.error('Error in /api/diet-image-migration/push-to-db:', error);
   return res.status(500).json({ ok: false, message: 'Push failed', error: error.message });
 }
});


module.exports = router;



