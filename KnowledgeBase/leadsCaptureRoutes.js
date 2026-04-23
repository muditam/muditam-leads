const express = require("express");
const requireSession = require("../middleware/requireSession");
const KnowledgeLead = require("./models/KnowledgeLead");


const router = express.Router();


function safeStr(v) {
 return String(v ?? "").trim();
}


function normalizePhone(v) {
 return String(v || "").replace(/\D/g, "").slice(-10);
}




router.post("/", requireSession, async (req, res) => {
 try {
   const name = safeStr(req.body?.name);
   const phone = safeStr(req.body?.phone);
   const normalizedPhone = normalizePhone(phone);


   if (!name) {
     return res.status(400).json({ message: "name is required" });
   }
   if (!normalizedPhone || normalizedPhone.length < 10) {
     return res.status(400).json({ message: "valid phone is required" });
   }


   const lead = await KnowledgeLead.create({
     name,
     phone,
     source: safeStr(req.body?.source || "knowledge_base").toLowerCase(),
     kbEntryId: safeStr(req.body?.kbEntryId) || null,
     metadata:
       req.body?.metadata && typeof req.body.metadata === "object" && !Array.isArray(req.body.metadata)
         ? req.body.metadata
         : {},
   });


   return res.status(201).json({
     success: true,
     lead,
   });
 } catch (e) {
   console.error("knowledge lead create error:", e);
   return res.status(500).json({
     message: "Failed to save lead",
     error: e?.message || String(e),
   });
 }
});


module.exports = router;



