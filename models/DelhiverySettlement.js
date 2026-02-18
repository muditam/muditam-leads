// models/DelhiverySettlement.js
const mongoose = require("mongoose");

const delhiverySchema = new mongoose.Schema(
  {
    uploadDate: { type: Date, default: Date.now, index: true },

    awbNo: { type: String, default: "" },
    utrNo: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    settledDate: { type: Date, default: null, index: true },  
    orderId: { type: String, default: "" },
  },
  { timestamps: true }
);

delhiverySchema.index({ awbNo: 1 });
delhiverySchema.index({ orderId: 1 });
delhiverySchema.index({ utrNo: 1 });

module.exports = mongoose.model("DelhiverySettlement", delhiverySchema);
