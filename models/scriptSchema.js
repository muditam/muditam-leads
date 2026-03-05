const mongoose = require("mongoose");


// ─────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────
const scriptSchema = new mongoose.Schema(
  {
    scriptId: { type: String, unique: true }, // SCR0001, SCR0002 …


    // ── CORE CONTENT ─────────────────────────────────────────
    scriptType: {
      type: String,
      enum: [
        "Muditam Instagram",
        "Muditam Snooze Well",
        "YouTube",
        "Meta Ads",
        "Google Ads",
        "WhatsApp",
      ],
      required: true,
    },
    scriptText:    { type: String, required: true },
    referenceLink: { type: String, default: "" },


    // ── CREATOR ───────────────────────────────────────────────
    createdBy:      { type: String, required: true },
    createdByEmail: { type: String, required: true },


    // ── SCRIPT REVIEW STATUS ─────────────────────────────────
    scriptStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rewrite", "On Hold", "Rejected"],
      default: "Pending",
    },
    approverComment: { type: String, default: "" },
    holdReason:      { type: String, default: "" }, // used for script-level hold


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
  if (this.isNew && !this.scriptId) {
    const Script = mongoose.model("Script");
    const count  = await Script.countDocuments();
    this.scriptId = `SCR${String(count + 1).padStart(4, "0")}`;
  }
  next();
});


const Script = mongoose.models.Script || mongoose.model("Script", scriptSchema);


module.exports = Script;

