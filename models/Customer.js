const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema({
  name: { type: String, required: true }, 
  phone: { type: String, required: true },
  age: { type: Number, required: true },
  location: { type: String },
  lookingFor: { type: String, required: true },
  assignedTo: { type: String, required: true },
  followUpDate: { type: Date, required: true },  
  leadSource: { type: String, required: true },
  leadDate:     { type: Date, required: true },
  leadStatus: { type: String, default: "New Lead" }, 
  subLeadStatus: { type: String },
  createdAt: { type: Date, default: Date.now },
  dateAndTime: { type: Date, default: () => new Date() },   
}); 

CustomerSchema.index({ phone: 1 });

async function enqueueCustomerForZoomSync(docLike) {
  try {
    const svc = require("../services/zoomContactSyncService");
    const name = String(docLike?.name || "").trim();
    const phone = String(docLike?.phone || "").trim();
    if (!phone) return;
    svc.enqueueContact({ name, phone, source: "Customer" });
  } catch (_) {
    // best-effort async sync hook
  }
}

async function syncCustomerConversationProfile(docLike) {
  try {
    const phone = String(docLike?.phone || "").trim();
    if (!phone) return;
    const { syncConversationByPhone } = require("../whatsapp/conversationProfile.service");
    await syncConversationByPhone(phone, {
      lastMessageText: String(docLike?.lastMessageText || "").trim(),
    });
  } catch (_) {
    // best-effort conversation sync hook
  }
}

CustomerSchema.post("save", function (doc) {
  enqueueCustomerForZoomSync(doc);
  syncCustomerConversationProfile(doc);
});

CustomerSchema.post("findOneAndUpdate", function (doc) {
  enqueueCustomerForZoomSync(doc);
  syncCustomerConversationProfile(doc);
});

CustomerSchema.post("updateOne", async function () {
  try {
    const filter = this.getQuery() || {};
    const doc = await mongoose.model("Customer").findOne(filter, { name: 1, phone: 1 }).lean();
    enqueueCustomerForZoomSync(doc);
    syncCustomerConversationProfile(doc);
  } catch (_) {}
});

module.exports = mongoose.model("Customer", CustomerSchema);
