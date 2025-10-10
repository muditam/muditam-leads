const mongoose = require("mongoose");

const AssetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    assetCode: { type: String, required: true, unique: true, trim: true },
    imageUrls: { type: [String], default: [] },  
  },
  { timestamps: true }
);

AssetSchema.index({ assetCode: 1 }, { unique: true }); 

module.exports = mongoose.model("Asset", AssetSchema); 