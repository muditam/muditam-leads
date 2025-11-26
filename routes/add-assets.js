const express = require("express");
const router = express.Router();
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const crypto = require("crypto");
const Asset = require("../models/Add-Asset");
const Employee = require("../models/Employee");

const {
  WASABI_ACCESS_KEY,
  WASABI_SECRET_KEY,
  WASABI_REGION,
  WASABI_BUCKET,
  WASABI_ENDPOINT,
} = process.env;

const s3 = new S3Client({
  region: WASABI_REGION,
  endpoint: WASABI_ENDPOINT,
  forcePathStyle: false,
  credentials: {
    accessKeyId: WASABI_ACCESS_KEY,
    secretAccessKey: WASABI_SECRET_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage() });
function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildAssetFilterFromQuery(query = {}) {
  const { q, type, employeeName, employeeId } = query;

  const andConditions = [];

  if (q && q.trim()) {
    const safe = escapeRegex(q.trim());
    const regex = new RegExp(safe, "i");

    andConditions.push({
      $or: [
        { assetCode: regex },
        { name: regex },
        { brand: regex },
        { model: regex },
        { allottedTo: regex },
        { emp_id: regex },
      ],
    });
  }

  if (type && type.trim()) {
    andConditions.push({ name: type.trim() });
  }

  if (
    (employeeName && employeeName.trim()) ||
    (employeeId && employeeId.trim())
  ) {
    const or = [];
    if (employeeName && employeeName.trim()) {
      or.push({ allottedTo: employeeName.trim() });
    }
    if (employeeId && employeeId.trim()) {
      or.push({ emp_id: employeeId.trim() });
    }
    if (or.length) {
      andConditions.push({ $or: or });
    }
  }

  if (!andConditions.length) return {};
  if (andConditions.length === 1) return andConditions[0];
  return { $and: andConditions };
}

router.get("/", async (req, res) => {
  try {
    let { page = 1, limit = 20, assigned } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);

    if (!Number.isFinite(page) || page < 1) page = 1;
    if (!Number.isFinite(limit) || limit < 1) limit = 20;
    if (limit > 200) limit = 200;  
    let match = buildAssetFilterFromQuery(req.query);

    // Assigned filter (chips)
    if (assigned === "ASSIGNED") {
      const cond = {
        $or: [
          { allottedTo: { $exists: true, $ne: "" } },
          { emp_id: { $exists: true, $ne: "" } },
        ],
      };
      match = Object.keys(match).length ? { $and: [match, cond] } : cond;
    } else if (assigned === "UNASSIGNED") {
      const cond = {
        $and: [
          {
            $or: [
              { allottedTo: { $exists: false } },
              { allottedTo: "" },
              { allottedTo: null },
            ],
          },
          {
            $or: [
              { emp_id: { $exists: false } },
              { emp_id: "" },
              { emp_id: null },
            ],
          },
        ],
      };
      match = Object.keys(match).length ? { $and: [match, cond] } : cond;
    } else if (assigned === "FAULTY") {
      const cond = { isFaulty: true };
      match = Object.keys(match).length ? { $and: [match, cond] } : cond;
    }

    const [items, total] = await Promise.all([
      Asset.find(match)
        .sort({ assetCode: 1 })  
        .skip(skip)
        .limit(limit)
        .lean(),
      Asset.countDocuments(match),
    ]);
    res.json({
      items,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("GET /assets error:", err);
    res.status(500).json({ message: "Failed to fetch assets" });
  }
});

router.get("/employees", async (_req, res) => {
  try {
    const employees = await Employee.find(
      { status: { $ne: "inactive" } }, // remove filter if you want all
      { fullName: 1 }
    )
      .sort({ fullName: 1 })
      .lean();

    const result = employees.map((e) => ({
      id: e._id, // Mongo _id
      name: e.fullName,
      employeeId: String(e._id), // used in frontend as emp_id
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /assets/employees error:", err);
    res.status(500).json({ message: "Failed to fetch employees" });
  }
});


router.get("/stats", async (req, res) => {
  try {
    const baseMatch = buildAssetFilterFromQuery(req.query);
    const hasBase = Object.keys(baseMatch).length > 0;

    const andWith = (extra) =>
      hasBase ? { $and: [baseMatch, extra] } : extra;

    const assignedCond = {
      $or: [
        { allottedTo: { $exists: true, $ne: "" } },
        { emp_id: { $exists: true, $ne: "" } },
      ],
    };

    const unassignedCond = {
      $and: [
        {
          $or: [
            { allottedTo: { $exists: false } },
            { allottedTo: "" },
            { allottedTo: null },
          ],
        },
        {
          $or: [
            { emp_id: { $exists: false } },
            { emp_id: "" },
            { emp_id: null },
          ],
        },
      ],
    };

    const faultyCond = { isFaulty: true };

    const [total, assigned, unassigned, faulty] = await Promise.all([
      Asset.countDocuments(baseMatch),
      Asset.countDocuments(andWith(assignedCond)),
      Asset.countDocuments(andWith(unassignedCond)),
      Asset.countDocuments(andWith(faultyCond)),
    ]);

    res.json({
      total,
      assigned,
      unassigned,
      faulty,
    });
  } catch (err) {
    console.error("GET /assets/stats error:", err);
    res.status(500).json({ message: "Failed to fetch asset stats" });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      name,
      company,
      brand,      // optional
      model,
      assetCode,
      imageUrls,
      allottedTo,
      emp_id,
      issuedDate,
      isFaulty,
      faultyRemark,
    } = req.body;

    if (!name || !company || !model || !assetCode) {
      return res.status(400).json({
        message: "name, company, model and assetCode are required",
      });
    }

    const existing = await Asset.findOne({ assetCode: assetCode.trim() });
    if (existing) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }

    const doc = await Asset.create({
      name: name.trim(),
      company: company.trim(),
      brand: brand?.trim() || "",
      model: model.trim(),
      assetCode: assetCode.trim(),
      allottedTo: allottedTo?.trim() || "",
      emp_id: emp_id?.trim() || "",
      issuedDate: issuedDate || null,
        isFaulty: !!isFaulty,
  faultyRemark: faultyRemark?.trim() || "",
      isFaulty: !!isFaulty,
      imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error("POST /assets error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }
    res.status(500).json({ message: "Failed to create asset" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const {
      name,
      company,
      brand,
      model,
      assetCode,
      imageUrls,
      allottedTo,
      emp_id,
      issuedDate,
      isFaulty,
        faultyRemark,
    } = req.body;

    if (!name || !company || !model || !assetCode) {
      return res.status(400).json({
        message: "name, company, model and assetCode are required",
      });
    }

    const existsWithCode = await Asset.findOne({
      assetCode: assetCode.trim(),
      _id: { $ne: req.params.id },
    });
    if (existsWithCode) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }

    const updated = await Asset.findByIdAndUpdate(
      req.params.id,
      {
        name: name.trim(),
        company: company.trim(),
        brand: brand?.trim() || "",
        model: model.trim(),
        assetCode: assetCode.trim(),
        allottedTo: allottedTo?.trim() || "",
        emp_id: emp_id?.trim() || "",
        issuedDate: issuedDate || null,
        isFaulty: !!isFaulty,
            isFaulty: !!isFaulty,
    faultyRemark: faultyRemark?.trim() || "",
        imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: "Asset not found" });
    res.json(updated);
  } catch (err) {
    console.error("PUT /assets/:id error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Asset Code must be unique" });
    }
    res.status(500).json({ message: "Failed to update asset" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Asset.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Asset not found" });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /assets/:id error:", err);
    res.status(500).json({ message: "Failed to delete asset" });
  }
});

router.post("/upload", upload.array("files", 15), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length)
      return res.status(400).json({ message: "No files uploaded" });

    const prefix = (req.body.prefix || "asset").replace(
      /[^a-z0-9/_-]/gi,
      "_"
    );

    // 🔹 upload in parallel instead of for..of + await
    const uploads = files.map((file) => {
      const ext = path.extname(file.originalname) || ".bin";
      const base = path
        .basename(file.originalname, ext)
        .replace(/[^a-z0-9/_-]/gi, "_");
      const hash = crypto.randomBytes(8).toString("hex");
      const key = `${prefix}/${base}-${Date.now()}-${hash}${ext}`;

      const put = new PutObjectCommand({
        Bucket: WASABI_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || "application/octet-stream",
        ACL: "public-read",
      });

      const url = `${WASABI_ENDPOINT}/${WASABI_BUCKET}/${encodeURIComponent(
        key
      )}`;

      // return promise that resolves to url
      return s3.send(put).then(() => url);
    });

    const uploadedUrls = await Promise.all(uploads);

    res.json({ ok: true, urls: uploadedUrls });
  } catch (err) {
    console.error("UPLOAD /assets/upload error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

router.patch("/:id/faulty", async (req, res) => {
  try {
    const { isFaulty, remark } = req.body;

    if (typeof isFaulty === "undefined") {
      return res.status(400).json({ message: "isFaulty is required" });
    }

    // 🔹 When marking as faulty => remark is mandatory
    if (isFaulty && (!remark || !remark.trim())) {
      return res
        .status(400)
        .json({ message: "Remark is required when marking asset as faulty" });
    }

    const update = { isFaulty: !!isFaulty };
    if (typeof remark === "string") {
      update.faultyRemark = remark.trim();
    }

    const updated = await Asset.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Asset not found" });
    }


    return res.json(updated);
  } catch (err) {
    console.error("PATCH /assets/:id/faulty error:", err);
    return res.status(500).json({ message: "Failed to update faulty status" });
  }
});

module.exports = router;
