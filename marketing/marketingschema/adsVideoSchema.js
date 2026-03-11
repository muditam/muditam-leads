const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.Counter || mongoose.model("Counter", counterSchema);

const adsVideoSchema = new mongoose.Schema(
  {
    adsVideoId: { type: String, unique: true, index: true },

    adType: {
      type: String,
      enum: [
        "Meta Ads",
        "Google Ads",
        "YouTube Ads",
        "WhatsApp Ads",
        "Other Ads",
      ],
      required: true,
      index: true,
    },

    title: { type: String, required: true, trim: true },
    ideaText: { type: String, required: true },
    referenceLink: { type: String, default: "" },

    // ✅ key difference: may or may not have a shoot
    hasShoot: { type: Boolean, default: true, index: true },

    createdBy: { type: String, required: true, index: true },
    createdByEmail: { type: String, required: true },

    ideationStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rewrite", "On Hold", "Rejected"],
      default: "Pending",
      index: true,
    },

    approverComment: { type: String, default: "" },
    holdReason: { type: String, default: "" },
    approvedBy: { type: String, default: "" },
    approvedAt: { type: Date },

    stage: {
      type: String,
      enum: [
        "Ideation",
        "Shoot Pending",
        "Shoot Done",
        "Cut Pending",
        "Cut Done",
        "Edit Pending",
        "Edit Done",
        "Post",
      ],
      default: "Ideation",
      index: true,
    },

    proceedAfterApprovalAt: { type: Date },

    shootDoneAt: { type: Date },
    shootDoneBy: { type: String, default: "" },

    // video-only flow
    cutVideoUrl: { type: String, default: "" },
    cutVideoName: { type: String, default: "" },
    cutComment: { type: String, default: "" },
    cutUploadedBy: { type: String, default: "" },
    cutDoneAt: { type: Date },
    cutDoneBy: { type: String, default: "" },

    editAssignedTo: { type: String, default: "", index: true },
    editStatus: {
      type: String,
      enum: ["", "On Hold", "Reshoot", "Re-edit", "Done"],
      default: "",
      index: true,
    },
    editHoldReason: { type: String, default: "" },
    editVideoUrl: { type: String, default: "" },
    editVideoName: { type: String, default: "" },
    editComment: { type: String, default: "" },
    editDoneAt: { type: Date },
    editDoneBy: { type: String, default: "" },

    postStatus: {
      type: String,
      enum: ["", "Approved", "Rewrite", "Reshoot", "Re-edit", "On Hold", "Rejected"],
      default: "",
      index: true,
    },
    postStatusUpdatedAt: { type: Date },
    postStatusUpdatedBy: { type: String, default: "" },
    postHoldReason: { type: String, default: "" },

    postPublishStatus: {
      type: String,
      enum: ["", "Posted", "Used in Ads"],
      default: "",
      index: true,
    },
    postPublishStatusUpdatedAt: { type: Date },

    postVideoUrl: { type: String, default: "" },
    postVideoName: { type: String, default: "" },
    postComment: { type: String, default: "" },

    postedAt: { type: Date },
    postedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

adsVideoSchema.index({ createdAt: -1 });
adsVideoSchema.index({ stage: 1, createdAt: -1 });
adsVideoSchema.index({ editAssignedTo: 1, stage: 1, createdAt: -1 });

adsVideoSchema.pre("save", async function (next) {
  if (!this.isNew || this.adsVideoId) return next();

  try {
    const counter = await Counter.findByIdAndUpdate(
      "adsVideoId",
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    this.adsVideoId = `ADV${String(counter.seq).padStart(4, "0")}`;
    return next();
  } catch (err) {
    return next(err);
  }
});

const AdsVideo =
  mongoose.models.AdsVideo || mongoose.model("AdsVideo", adsVideoSchema);

module.exports = AdsVideo;