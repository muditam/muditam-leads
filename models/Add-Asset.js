const mongoose = require("mongoose");


const AssetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    assetCode: { type: String, required: true, unique: true, trim: true },
    brand:    { type: String, trim: true },
    imageUrls: { type: [String], default: [] },
    // Employee fields
    allottedTo: { type: String, trim: true },
    emp_id: { type: String, trim: true },
      isFaulty: { type: Boolean, default: false },
    faultyRemark: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);


AssetSchema.index({ assetCode: 1 }, { unique: true });
AssetSchema.index({ emp_id: 1 }); // Index for employee search


module.exports = mongoose.model("Asset", AssetSchema);

