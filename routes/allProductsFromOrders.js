// routes/allProductsFromOrders.js
const express = require("express");
const router = express.Router();

// Adjust path to your actual model location
const ShopifyOrder = require("../models/ShopifyOrder");

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/**
 * GET /api/products/from-orders
 * Deduped by variant_id; if missing/invalid, fallback identity = title|sku|price
 * Returns: title, sku, variantId, price, month, cohort
 */
router.get("/products/from-orders", async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = toInt(page, 1);
    const perPage = Math.min(toInt(limit, 50), 200);

    const pipeline = [
      { $project: { productsOrdered: 1 } },
      { $unwind: "$productsOrdered" },

      // Robust grouping key
      {
        $addFields: {
          groupKey: {
            $cond: [
              {
                $and: [
                  { $ifNull: ["$productsOrdered.variant_id", false] },
                  { $gt: ["$productsOrdered.variant_id", 0] },
                ],
              },
              { $concat: ["vid:", { $toString: "$productsOrdered.variant_id" }] },
              {
                // Fallback groups by title|sku|price to avoid collisions when sku is empty/shared
                $concat: [
                  "fallback:",
                  { $ifNull: ["$productsOrdered.title", ""] },
                  "|",
                  { $ifNull: ["$productsOrdered.sku", ""] },
                  "|",
                  { $toString: { $ifNull: ["$productsOrdered.price", 0] } },
                ],
              },
            ],
          },
        },
      },

      // Group to one row per identity
      {
        $group: {
          _id: "$groupKey",
          title:     { $first: "$productsOrdered.title" },
          sku:       { $first: "$productsOrdered.sku" },
          price:     { $first: "$productsOrdered.price" },
          variantId: { $first: "$productsOrdered.variant_id" },
          month:     { $first: "$productsOrdered.month" },
          cohort:    { $first: "$productsOrdered.cohort" },
        },
      },

      { $sort: { title: 1 } },

      {
        $facet: {
          meta: [{ $count: "total" }],
          data: [
            { $skip: (pageNum - 1) * perPage },
            { $limit: perPage },
            {
              $project: {
                _id: 0,
                title: 1,
                sku: { $ifNull: ["$sku", ""] },
                variantId: 1,
                price: { $ifNull: ["$price", 0] },
                month: { $ifNull: ["$month", ""] },
                cohort: { $ifNull: ["$cohort", "Yes"] },
              },
            },
          ],
        },
      },
      {
        $project: {
          total: { $ifNull: [{ $arrayElemAt: ["$meta.total", 0] }, 0] },
          data: 1,
        },
      },
    ];

    const [result] = await ShopifyOrder.aggregate(pipeline).allowDiskUse(true);
    const total = result?.total || 0;
    const data = result?.data || [];

    res.json({
      page: pageNum,
      limit: perPage,
      total,
      totalPages: Math.ceil(total / perPage),
      data,
    });
  } catch (err) {
    console.error("Error aggregating products from orders:", err);
    res.status(500).json({ message: "Error aggregating products from orders" });
  }
});

// routes/allProductsFromOrders.js  (replace ONLY the POST handler)

router.post("/products/from-orders/meta", async (req, res) => {
  try {
    const { variantId, title, sku, price, month, cohort } = req.body || {};

    const hasVariant = variantId != null && Number(variantId) > 0;
    const normSku = sku ?? "";
    const normPrice = price != null ? Number(price) : null;

    // Validate match keys
    if (!hasVariant) {
      if (!title || normPrice == null || Number.isNaN(normPrice)) {
        return res.status(400).json({
          message:
            "When variantId is not provided, you must send title and price (and sku if available).",
        });
      }
    }

    // Validate cohort
    if (cohort !== undefined && !["Yes", "No", ""].includes(cohort)) {
      return res
        .status(400)
        .json({ message: "cohort must be 'Yes', 'No', or empty string" });
    }

    // Build the inlined "patch" for each matching product row
    // If a field isn't provided, keep the old value.
    const monthExpr =
      month !== undefined ? month : "$$p.month"; // keep existing if not provided
    const cohortExpr =
      cohort !== undefined ? cohort : "$$p.cohort"; // keep existing if not provided

    // Condition expressions for matching a single line item in productsOrdered
    let itemMatchExpr;
    let topLevelMatch;

    if (hasVariant) {
      const vId = Number(variantId);
      topLevelMatch = { "productsOrdered.variant_id": vId };
      itemMatchExpr = { $eq: ["$$p.variant_id", vId] };
    } else {
      // fallback: match ONLY rows that lack a real variant_id and match title|sku|price
      topLevelMatch = { "productsOrdered.title": title };
      itemMatchExpr = {
        $and: [
          { $eq: ["$$p.title", title] },
          { $eq: ["$$p.sku", normSku] },
          { $eq: ["$$p.price", normPrice] },
          {
            $or: [
              { $not: ["$$p.variant_id"] }, // covers undefined / null
              { $eq: ["$$p.variant_id", null] },
              { $eq: ["$$p.variant_id", 0] },
            ],
          },
        ],
      };
    }

    // Pipeline update: $set productsOrdered = map over array and patch only matches
    const result = await ShopifyOrder.updateMany(
      topLevelMatch,
      [
        {
          $set: {
            productsOrdered: {
              $map: {
                input: "$productsOrdered",
                as: "p",
                in: {
                  $cond: [
                    itemMatchExpr,
                    {
                      $mergeObjects: [
                        "$$p",
                        { month: monthExpr, cohort: cohortExpr },
                      ],
                    },
                    "$$p",
                  ],
                },
              },
            },
          },
        },
      ]
    );

    res.json({
      matched: result.matchedCount ?? result.nMatched,
      modified: result.modifiedCount ?? result.nModified,
    });
  } catch (err) {
    console.error("Error saving product meta (pipeline):", err);
    res.status(500).json({ message: "Error saving product meta" });
  }
});


module.exports = router;
 