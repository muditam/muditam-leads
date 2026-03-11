const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.Counter || mongoose.model("Counter", counterSchema);

const assetSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    name: { type: String, default: "" },
    key: { type: String, default: "" },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: String, default: "" },
  },
  { _id: false }
);

const contentItemSchema = new mongoose.Schema(
  {
    itemNo: { type: Number, required: true },
    headline: { type: String, default: "" },
    subHeadline: { type: String, default: "" },
    caption: { type: String, default: "" },
    description: { type: String, default: "" },
    cta: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const STATIC_CAROUSEL_TYPES = [
  "Muditam Instagram",
  "Muditam Snooze Well",
  "Muditam infographic",
  "Snooze Well infographic",
  "YouTube",
  "Meta Ads KJF",
  "Meta Ads Liver Fix",
  "Meta Ads International",
  "Meta Ads Others",
  "Google Ads",
  "WhatsApp",
];

const staticCarouselSchema = new mongoose.Schema(
  {
    staticCarouselId: {
      type: String,
      unique: true,
      index: true,
    },

    contentType: {
      type: String,
      enum: ["Static", "Carousel"],
      required: true,
      index: true,
    },

    hasShoot: {
      type: Boolean,
      default: false,
      index: true,
    },

    scriptType: {
      type: String,
      enum: STATIC_CAROUSEL_TYPES,
      required: true,
      index: true,
    },

    title: { type: String, default: "" },

    // Static = 1 item
    // Carousel = multiple items
    contentItems: {
      type: [contentItemSchema],
      default: [],
    },

    referenceLink: { type: String, default: "" },

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

    approvedAt: { type: Date },
    approvedBy: { type: String, default: "" },

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

    proceedToShootAt: { type: Date },
    proceedToEditAt: { type: Date },

    shootDoneAt: { type: Date },
    shootDoneBy: { type: String, default: "" },

    // Raw / selected images after shoot
    cutAssets: {
      type: [assetSchema],
      default: [],
    },
    cutComment: { type: String, default: "" },
    cutDoneAt: { type: Date },
    cutDoneBy: { type: String, default: "" },
    cutUploadedBy: { type: String, default: "" },

    editAssignedTo: { type: String, default: "", index: true },
    editStatus: {
      type: String,
      enum: ["", "On Hold", "Reshoot", "Re-edit", "Done"],
      default: "",
    },
    editHoldReason: { type: String, default: "" },

    // Final edited images
    editAssets: {
      type: [assetSchema],
      default: [],
    },
    editComment: { type: String, default: "" },
    editDoneAt: { type: Date },
    editDoneBy: { type: String, default: "" },

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

    // Optional post-ready images
    postAssets: {
      type: [assetSchema],
      default: [],
    },
    postComment: { type: String, default: "" },

    postedAt: { type: Date },
    postedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

staticCarouselSchema.index({ createdAt: -1 });
staticCarouselSchema.index({ updatedAt: -1 });
staticCarouselSchema.index({ proceedToShootAt: -1 });
staticCarouselSchema.index({ proceedToEditAt: -1 });
staticCarouselSchema.index({ shootDoneAt: -1 });
staticCarouselSchema.index({ cutDoneAt: -1 });
staticCarouselSchema.index({ editDoneAt: -1 });
staticCarouselSchema.index({ postedAt: -1 });

staticCarouselSchema.pre("save", async function (next) {
  if (!this.isNew || this.staticCarouselId) return next();

  try {
    const counter = await Counter.findByIdAndUpdate(
      "staticCarouselId",
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    this.staticCarouselId = `STC${String(counter.seq).padStart(4, "0")}`;
    return next();
  } catch (err) {
    return next(err);
  }
});

const StaticCarousel =
  mongoose.models.StaticCarousel ||
  mongoose.model("StaticCarousel", staticCarouselSchema);

module.exports = StaticCarousel;