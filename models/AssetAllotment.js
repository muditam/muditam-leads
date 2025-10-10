const mongoose = require("mongoose");

const AssetAllotmentSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
 
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    assetCode: { type: String, required: true, trim: true },

    allotmentImageUrls: { type: [String], default: [] },
    allottedAt: { type: Date, default: Date.now }, 
    status: { type: String, enum: ["allocated", "returned"], default: "allocated", index: true },
    returnedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

AssetAllotmentSchema.index({ assetCode: 1, status: 1 }); 

module.exports = mongoose.model("AssetAllotment", AssetAllotmentSchema);
