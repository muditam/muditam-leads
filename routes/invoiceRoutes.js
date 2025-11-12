const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');


const s3Client = new S3Client({
  endpoint: process.env.WASABI_ENDPOINT,
  region: process.env.WASABI_REGION,
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY
  }
});


const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });


function getUser(req) {
  return req.session?.user ||
    (req.headers['x-user-json'] ? JSON.parse(req.headers['x-user-json']) : null);
}


// Upload file (multipart field: file)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const user = getUser(req);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });


    const key = `invoices/${user._id || 'anon'}/${Date.now()}-${req.file.originalname.replace(/[^\w.\-]/g, '_')}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read'
    }));


    const fileUrl = `https://${process.env.WASABI_BUCKET}.s3.${process.env.WASABI_REGION}.wasabisys.com/${key}`;
    res.json({ fileUrl });
  } catch (e) {
    console.error('POST /api/invoices/upload error:', e);
    res.status(500).json({ message: 'Upload failed' });
  }
});


// Create invoice (metadata after upload)
router.post('/', async (req, res) => {
  try {
    const user = getUser(req);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });


    const { companyName, amount, fileUrl, originalFilename } = req.body || {};
    if (!companyName || amount == null || !fileUrl)
      return res.status(400).json({ message: 'companyName, amount, fileUrl required' });


    const uid = user._id || user.id || user.userId || null;
    const hasValidOid = uid && mongoose.Types.ObjectId.isValid(uid);
    const employee = hasValidOid ? new mongoose.Types.ObjectId(uid) : undefined;


    const doc = await Invoice.create({
      employee,
      uploadedBy: {
        id: uid ? String(uid) : undefined,
        name: user.fullName || user.name || undefined,
        email: user.email || undefined,
        role: user.role || undefined,
      },
      companyName: String(companyName).trim(),
      amount: Number(amount),
      fileUrl,
      originalFilename: originalFilename || undefined,
    });


    res.status(201).json({ id: String(doc._id), message: 'Invoice saved' });
  } catch (e) {
    console.error('POST /api/invoices error:', e);
    res.status(500).json({ message: 'Failed to save invoice' });
  }
});


// List (finance sees all, others own)
router.get('/', async (req, res) => {
  try {
    const user = getUser(req);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });


    const role = (user.role || '').toLowerCase();
    const uid = user._id || user.id || user.userId || null;
    const hasValidOid = uid && mongoose.Types.ObjectId.isValid(uid);


    const filter = role === 'finance'
      ? {}
      : (hasValidOid
          ? { $or: [{ employee: new mongoose.Types.ObjectId(uid) }, { 'uploadedBy.id': String(uid) }] }
          : { 'uploadedBy.id': String(uid) });


    const list = await Invoice.find(filter).sort({ createdAt: -1 }).lean();
    res.json(list.map((d, i) => ({
      id: String(d._id),
      sNo: i + 1,
      companyName: d.companyName,
      amount: d.amount,
      status: d.status,
      fileUrl: d.fileUrl,
      originalFilename: d.originalFilename,
      uploadedAt: d.createdAt
    })));
  } catch (e) {
    console.error('GET /api/invoices error:', e);
    res.status(500).json({ message: 'Failed to load invoices' });
  }
});


// Update status (finance only)
router.patch('/:id/status', async (req, res) => {
  try {
    const user = getUser(req);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    if ((user.role || '').toLowerCase() !== 'finance')
      return res.status(403).json({ message: 'Forbidden' });


    const { status } = req.body || {};
    if (!['pending', 'clear'].includes(status))
      return res.status(400).json({ message: 'Invalid status' });


    const updated = await Invoice.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).lean();


    if (!updated) return res.status(404).json({ message: 'Not found' });
    res.json({ id: String(updated._id), status: updated.status });
  } catch (e) {
    console.error('PATCH /api/invoices/:id/status error:', e);
    res.status(500).json({ message: 'Failed to update status' });
  }
});


module.exports = router;

