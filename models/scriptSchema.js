const mongoose = require("mongoose");
 
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);
 
 
const scriptSchema = new mongoose.Schema(
  {
    scriptId: { type: String, unique: true },
 
    scriptType: {
      type: String,
      enum: [
        "Muditam Instagram",
        "Muditam Snooze Well",
        "Muditam infographic",
        "Snooze Well infographic",
        "YouTube",
        "Meta Ads",
        "Google Ads",
        "WhatsApp",
      ],
      required: true,
    },
    scriptText:    { type: String, required: true },
    referenceLink: { type: String, default: "" },
 
    createdBy:      { type: String, required: true },
    createdByEmail: { type: String, required: true },
 
    scriptStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rewrite", "On Hold", "Rejected"],
      default: "Pending",
    },
    approverComment: { type: String, default: "" },
    holdReason:      { type: String, default: "" },
 
    stage: {
      type: String,
      enum: [
        "Script",
        "Shoot Pending",
        "Shoot Done",
        "Cut Pending",
        "Cut Done",
        "Edit Pending",
        "Edit Done",
        "Post",
      ],
      default: "Script",
    },
 
    proceedToShootAt: { type: Date },
    shootDoneAt:      { type: Date },
    shootDoneBy:      { type: String, default: "" },
 
    cutVideoUrl:  { type: String, default: "" },
    cutVideoName: { type: String, default: "" },
    cutComment:   { type: String, default: "" },
    cutDoneAt:    { type: Date },
    cutDoneBy:    { type: String, default: "" },
 
    editAssignedTo: { type: String, default: "" },
    editStatus: {
      type: String,
      enum: ["", "On Hold", "Reshoot", "Re-edit", "Done"],
      default: "",
    },
    editHoldReason: { type: String, default: "" },
    editFileUrl:    { type: String, default: "" },
    editFileName:   { type: String, default: "" },
    editComment:    { type: String, default: "" },
    editDoneAt:     { type: Date },
    editDoneBy:     { type: String, default: "" },

    editThumbUrl:  { type: String, default: "" },
    editThumbName: { type: String, default: "" },
    editThumbUpdatedAt: { type: Date },
    editThumbUpdatedBy: { type: String, default: "" },
 
    postStatus: {
      type: String,
      enum: ["", "Approved", "Rewrite", "Reshoot", "Re-edit", "On Hold", "Rejected"],
      default: "",
    },
    postStatusUpdatedAt: { type: Date },
    postStatusUpdatedBy: { type: String, default: "" },
 
    postHoldReason: { type: String, default: "" },
 
    postPublishStatus: {
      type: String,
      enum: ["", "Posted", "Used in Ads"],
      default: "",
    },
    postPublishStatusUpdatedAt: { type: Date },
 
    postFileUrl:  { type: String, default: "" },
    postFileName: { type: String, default: "" },
    postComment:  { type: String, default: "" },
 
    postedAt: { type: Date },
    postedBy: { type: String, default: "" },
  },
  { timestamps: true }
);
 
 
scriptSchema.pre("save", async function (next) {
  if (!this.isNew || this.scriptId) return next();
 
  try {
 
    const counter = await Counter.findByIdAndUpdate(
      "scriptId",                
      { $inc: { seq: 1 } },        
      { new: true, upsert: true }  
    );
 
    this.scriptId = `SCR${String(counter.seq).padStart(4, "0")}`;
    return next();
  } catch (err) {
    return next(err);
  }
});
 
const Script = mongoose.models.Script || mongoose.model("Script", scriptSchema);
 
module.exports = Script;