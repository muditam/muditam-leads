const mongoose = require("mongoose");


const PaymentRecordSchema = new mongoose.Schema(
  {
    vendorName: { type: String, default: "" },
    date: { type: Date, default: null },


    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },    


    screenshot: { type: String, default: "" },


    dueLocked: { type: Boolean, default: false },


    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);


module.exports = mongoose.model("PaymentRecord", PaymentRecordSchema);



