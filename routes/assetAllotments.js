// routes/assetAllotments.js
const express = require("express");
const router = express.Router();


const AssetAllotment = require("../models/AssetAllotment");
const Employee = require("../models/Employee");


router.get("/", async (_req, res) => {
  try {
    const items = await AssetAllotment.find()
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 });


    res.json(items);
  } catch (err) {
    console.error("GET /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to fetch allotments" });
  }
});


router.post("/", async (req, res) => {
  try {
    const {
      employeeId,
      name,
      company,
      model,
      assetCode,
      allotmentImageUrls,
    } = req.body;


    if (!employeeId || !name || !company || !model || !assetCode) {
      return res.status(400).json({
        message:
          "employeeId, name, company, model, and assetCode are required",
      });
    }


    const emp = await Employee.findById(employeeId);
    if (!emp) {
      return res.status(404).json({ message: "Employee not found" });
    }


    let imageUrls = Array.isArray(allotmentImageUrls)
      ? allotmentImageUrls
      : [];
    imageUrls = imageUrls
      .filter(Boolean)
      .map((u) => String(u).trim())
      .slice(0, 50);


    const now = new Date();


    const doc = await AssetAllotment.create({
      employee: employeeId,
      name: String(name).trim(),
      company: String(company).trim(),
      model: String(model).trim(),
      assetCode: String(assetCode).trim(),
      allotmentImageUrls: imageUrls,
      status: "allocated",
      allottedAt: now,
    });


    const populated = await doc.populate("employee", "fullName email");
    res.status(201).json(populated);
  } catch (err) {
    console.error("POST /asset-allotments error:", err);
    res.status(500).json({ message: "Failed to create allotment" });
  }
});
// router.post("/upload", upload.array("files", 15), async (req, res) => {
//   try {
//     const files = req.files || [];
//     if (!files.length)
//       return res.status(400).json({ message: "No files uploaded" });


//     const prefix = (req.body.prefix || "asset").replace(
//       /[^a-z0-9/_-]/gi,
//       "_"
//     );


//     // 🔹 upload in parallel instead of for..of + await
//     const uploads = files.map((file) => {
//       const ext = path.extname(file.originalname) || ".bin";
//       const base = path
//         .basename(file.originalname, ext)
//         .replace(/[^a-z0-9/_-]/gi, "_");
//       const hash = crypto.randomBytes(8).toString("hex");
//       const key = `${prefix}/${base}-${Date.now()}-${hash}${ext}`;


//       const put = new PutObjectCommand({
//         Bucket: WASABI_BUCKET,
//         Key: key,
//         Body: file.buffer,
//         ContentType: file.mimetype || "application/octet-stream",
//         ACL: "public-read",
//       });


//       const url = `${WASABI_ENDPOINT}/${WASABI_BUCKET}/${encodeURIComponent(
//         key
//       )}`;


//       // return promise that resolves to url
//       return s3.send(put).then(() => url);
//     });


//     const uploadedUrls = await Promise.all(uploads);


//     res.json({ ok: true, urls: uploadedUrls });
//   } catch (err) {
//     console.error("UPLOAD /assets/upload error:", err);
//     res.status(500).json({ message: "Upload failed" });
//   }
// });




router.patch("/:id/collect", async (req, res) => {
  try {
    const { id } = req.params;
    const { returnedAt, notes, returnImageUrls } = req.body;


    const retDate = returnedAt ? new Date(returnedAt) : new Date();
    if (Number.isNaN(retDate.getTime())) {
      return res.status(400).json({ message: "Invalid returnedAt date" });
    }


    let returnImgs = Array.isArray(returnImageUrls)
      ? returnImageUrls
      : [];
    returnImgs = returnImgs
      .filter(Boolean)
      .map((u) => String(u).trim())
      .slice(0, 50);


    const update = {
      returnedAt: retDate,
      notes: notes || "",
      status: "returned",
      returnImageUrls: returnImgs,
    };


    const doc = await AssetAllotment.findByIdAndUpdate(id, update, {
      new: true,
    }).populate("employee", "fullName email");


    if (!doc) {
      return res.status(404).json({ message: "Allotment not found" });
    }


    res.json(doc);
  } catch (err) {
    console.error("PATCH /asset-allotments/:id/collect error:", err);
    res.status(500).json({ message: "Failed to mark as collected" });
  }
});






router.get("/journey/:assetCode", async (req, res) => {
  try {
    const code = String(req.params.assetCode || "").trim();
    if (!code) {
      return res.status(400).json({ message: "assetCode is required" });
    }


    const rows = await AssetAllotment.find({
      assetCode: code,
      status: "returned",             // only completed legs
      returnedAt: { $ne: null },
    })
      .populate("employee", "fullName email")
      .sort({ allottedAt: 1, createdAt: 1 });


    const timeline = rows.map((doc) => ({
      _id: doc._id,
      assetCode: doc.assetCode,
      name: doc.name,  
      assetName: doc.name,
      company: doc.company,
      model: doc.model,


      employee: doc.employee, // { _id, fullName, email }
      employeeName: doc.employee?.fullName || "",
      employeeId: doc.employee?._id || null,


      // 👇 use the same field names your frontend already uses
      status: doc.status,             // "returned"
      allottedAt: doc.allottedAt,     // Date of Assign
      returnedAt: doc.returnedAt,     // Date of Collection


      notes: doc.notes || "",
      allotmentImageUrls: doc.allotmentImageUrls || [],
      returnImageUrls: doc.returnImageUrls || [],
    }));


    res.json(timeline);
  } catch (err) {
    console.error("GET /asset-allotments/journey/:assetCode error:", err);
    res.status(500).json({ message: "Failed to fetch asset journey" });
  }
});
router.get("/employee/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId) {
      return res.status(400).json({ message: "employeeId is required" });
    }


    const includeReturned =
      String(req.query.includeReturned || "0").trim() === "1";


    const filter = { employee: employeeId };
    if (!includeReturned) {
      // only currently allotted assets
      filter.status = { $ne: "returned" };
    }


    const items = await AssetAllotment.find(filter)
      .populate("employee", "fullName email")
      .sort({ allottedAt: -1, createdAt: -1 });


    res.json(items);
  } catch (err) {
    console.error(
      "GET /asset-allotments/employee/:employeeId error:",
      err
    );
    res.status(500).json({ message: "Failed to fetch employee allotments" });
  }
});




module.exports = router;



