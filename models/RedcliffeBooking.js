const mongoose = require("mongoose");

const RedcliffeBookingSchema = new mongoose.Schema(
  {
    bookingId: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, default: "", index: true },
    referenceData: { type: String, default: "", index: true },
    bookingDate: { type: String, default: "", index: true },
    collectionDate: { type: String, default: "", index: true },
    collectionSlot: { type: mongoose.Schema.Types.Mixed, default: null },
    collectionSlotId: { type: String, default: "" },
    collectionTime: { type: mongoose.Schema.Types.Mixed, default: null },
    bookingStatus: { type: mongoose.Schema.Types.Mixed, default: null },
    pickupStatus: { type: String, default: "" },
    reportStatus: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    phoneTail: { type: String, default: "", index: true },
    address: { type: String, default: "" },
    landmark: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    latitude: { type: String, default: "" },
    longitude: { type: String, default: "" },
    pincode: { type: String, default: "" },
    phleboDetail: { type: mongoose.Schema.Types.Mixed, default: null },
    paymentDetail: { type: mongoose.Schema.Types.Mixed, default: null },
    patients: { type: [mongoose.Schema.Types.Mixed], default: [] },
    packages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reportSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    report: { type: [mongoose.Schema.Types.Mixed], default: [] },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSource: { type: String, default: "unknown" },
    lastWebhookType: { type: String, default: "" },
    lastWebhookAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

RedcliffeBookingSchema.index({ updatedAt: -1 });
RedcliffeBookingSchema.index({ collectionDate: 1, updatedAt: -1 });

module.exports =
  mongoose.models.RedcliffeBooking ||
  mongoose.model("RedcliffeBooking", RedcliffeBookingSchema);
