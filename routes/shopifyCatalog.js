const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = express.Router();

const REDCLIFFE_PRICE_PRODUCT_ID =
  process.env.REDCLIFFE_PRICE_PRODUCT_ID || "9495156556086";
const REDCLIFFE_DEFAULT_INVENTORY = Number(
  process.env.REDCLIFFE_PRICE_DEFAULT_INVENTORY || 200
);

const rawShop = (process.env.SHOPIFY_STORE_NAME || "").trim();
const SHOPIFY_SHOP = rawShop.includes(".myshopify.com")
  ? rawShop
  : `${rawShop}.myshopify.com`;

const SHOPIFY_ACCESS_TOKEN =
  process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

const SHOPIFY_GRAPHQL_URL = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

function toProductGid(productId = REDCLIFFE_PRICE_PRODUCT_ID) {
  const raw = String(productId || "").trim();
  return raw.startsWith("gid://shopify/Product/")
    ? raw
    : `gid://shopify/Product/${raw}`;
}

function parseMoney(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100) / 100;
}

function moneyString(value) {
  const amount = parseMoney(value);
  return amount === null ? null : amount.toFixed(2);
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function variantKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePriceCategory(value) {
  const text = normalizeText(value);
  const normalized = text.toLowerCase();
  if (!normalized) return "";
  if (normalized === "r1" || normalized.includes("routine")) return "R1";
  if (normalized === "r2" || normalized.includes("speciality") || normalized.includes("specialty")) return "R2";
  if (normalized === "r4" || normalized.includes("package")) return "R4";
  if (normalized.includes("home") || normalized.includes("collection")) {
    return "Home Collection Charges";
  }
  return ["R1", "R2", "R4", "Home Collection Charges"].includes(text) ? text : "";
}

function getCategoryDiscount(category) {
  const discounts = {
    R1: 40,
    R2: 20,
    R4: 25,
    "Home Collection Charges": 0,
  };
  const normalizedCategory = normalizePriceCategory(category);
  return Object.prototype.hasOwnProperty.call(discounts, normalizedCategory)
    ? discounts[normalizedCategory]
    : null;
}

function supportsIdempotentDirective() {
  const version = String(SHOPIFY_API_VERSION || "").trim().toLowerCase();
  if (version === "latest" || version === "unstable") return true;
  const match = version.match(/^(\d{4})-(\d{2})$/);
  if (!match) return false;
  const numericVersion = Number(`${match[1]}${match[2]}`);
  return numericVersion >= 202601;
}

function calculateDiscount(mrp, ourPrice, discount) {
  const discountValue = parseMoney(discount);
  if (discountValue !== null) return Math.min(Math.max(discountValue, 0), 100);
  const mrpValue = parseMoney(mrp);
  const priceValue = parseMoney(ourPrice);
  if (!mrpValue || priceValue === null || priceValue > mrpValue) return 0;
  return Math.round(((mrpValue - priceValue) / mrpValue) * 10000) / 100;
}

function normalizePriceRow(row = {}) {
  const testName = normalizeText(
    row.testName || row.name || row.test_name || row.packageName
  );
  const code = normalizeText(row.code || row.testCode || row.package_code);
  const category = normalizePriceCategory(
    row.category || row.pricingCategory || row.price_category || row.category_name || row.package_category
  );
  const mrp = parseMoney(row.mrp ?? row.MRP ?? row.price);
  const b2bPrice = parseMoney(row.b2bPrice ?? row.b2b_price ?? row.b2b);
  const ourPrice = parseMoney(
    row.ourPrice ?? row.our_price ?? row.finalPrice ?? row.final_price ?? row.price
  );
  const categoryDiscount = getCategoryDiscount(category);
  const discount = calculateDiscount(
    mrp,
    ourPrice,
    row.discount ?? row.discountPercent ?? categoryDiscount
  );

  if (!testName) {
    throw new Error("Test name is required");
  }
  if (ourPrice === null || ourPrice <= 0) {
    throw new Error(`Final Price is required for ${testName}`);
  }

  return {
    testName,
    code,
    category,
    mrp,
    b2bPrice,
    ourPrice,
    discount,
  };
}

async function shopifyGraphQL(query, variables = {}) {
  if (!rawShop || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error("Shopify store name or access token is not configured");
  }

  const response = await axios.post(
    SHOPIFY_GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      timeout: 30000,
    }
  );

  if (response.data?.errors?.length) {
    throw new Error(response.data.errors.map((e) => e.message).join(", "));
  }

  return response.data.data;
}

function extractUserErrors(payload) {
  const errors = payload?.userErrors || [];
  if (!errors.length) return "";
  return errors
    .map((error) => {
      const field = Array.isArray(error.field) ? error.field.join(".") : error.field;
      return field ? `${field}: ${error.message}` : error.message;
    })
    .join("; ");
}

async function getRedcliffeProduct(productId = REDCLIFFE_PRICE_PRODUCT_ID) {
  const query = `
    query RedcliffePriceProduct($id: ID!, $after: String) {
      product(id: $id) {
        id
        legacyResourceId
        title
        handle
        options {
          id
          name
          values
        }
        variants(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              legacyResourceId
              title
              displayName
              sku
              price
              compareAtPrice
              inventoryQuantity
              inventoryItem {
                id
              }
              selectedOptions {
                name
                value
              }
              metafields(first: 20, namespace: "redcliffe") {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let after = null;
  let product = null;
  const variantEdges = [];

  do {
    const data = await shopifyGraphQL(query, { id: toProductGid(productId), after });
    if (!data.product) {
      throw new Error(`Shopify product ${productId} was not found`);
    }
    if (!product) {
      product = data.product;
      product.variants = { edges: [] };
    }
    variantEdges.push(...(data.product.variants?.edges || []));
    after = data.product.variants?.pageInfo?.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
  } while (after);

  if (!product) {
    throw new Error(`Shopify product ${productId} was not found`);
  }

  product.variants = { edges: variantEdges };
  return product;
}

async function getProductVariantsBasic(productId = REDCLIFFE_PRICE_PRODUCT_ID) {
  const query = `
    query RedcliffeBasicVariants($id: ID!, $after: String) {
      product(id: $id) {
        variants(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              legacyResourceId
              title
              displayName
              sku
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  `;

  let after = null;
  const variants = [];
  do {
    const data = await shopifyGraphQL(query, { id: toProductGid(productId), after });
    if (!data.product) {
      throw new Error(`Shopify product ${productId} was not found`);
    }
    variants.push(...(data.product.variants?.edges || []).map(({ node }) => ({
      id: node.id,
      variantId: String(node.legacyResourceId || ""),
      title: node.title,
      displayName: node.displayName,
      sku: node.sku || "",
      price: node.price || "0",
      compareAtPrice: node.compareAtPrice || "",
      inventoryQuantity: node.inventoryQuantity ?? 0,
      availableForSale: Boolean(node.availableForSale),
      selectedOptions: (node.selectedOptions || []).map((option) => ({
        name: option.name,
        value: option.value,
      })),
      redcliffe: {},
    })));
    after = data.product.variants?.pageInfo?.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
  } while (after);

  return variants;
}

function mapVariant(node) {
  const metafields = {};
  (node.metafields?.edges || []).forEach(({ node: metafield }) => {
    metafields[metafield.key] = metafield.value;
  });

  return {
    id: node.id,
    variantId: String(node.legacyResourceId || ""),
    title: node.title,
    displayName: node.displayName,
    sku: node.sku || "",
    price: node.price || "",
    compareAtPrice: node.compareAtPrice || "",
    inventoryQuantity: node.inventoryQuantity ?? 0,
    inventoryItemId: node.inventoryItem?.id || "",
    selectedOptions: (node.selectedOptions || []).map((option) => ({
      name: option.name,
      value: option.value,
    })),
    redcliffe: metafields,
  };
}

async function getFirstLocationId() {
  const query = `
    query FirstLocation {
      locations(first: 1) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  return data.locations?.edges?.[0]?.node?.id || "";
}

async function activateInventoryAtLocation(inventoryItemId, locationId, quantity) {
  if (!inventoryItemId || !locationId) return null;
  const useIdempotent = supportsIdempotentDirective();

  const mutation = `
    mutation ActivateInventoryItem(
      $inventoryItemId: ID!,
      $locationId: ID!,
      $available: Int${useIdempotent ? ",\n      $idempotencyKey: String!" : ""}
    ) {
      inventoryActivate(
        inventoryItemId: $inventoryItemId,
        locationId: $locationId,
        available: $available
      ) ${useIdempotent ? "@idempotent(key: $idempotencyKey)" : ""} {
        inventoryLevel {
          id
          quantities(names: ["available"]) {
            name
            quantity
          }
          item {
            id
          }
          location {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    inventoryItemId,
    locationId,
    available: quantity,
  };

  if (useIdempotent) {
    variables.idempotencyKey =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
  }

  const data = await shopifyGraphQL(mutation, variables);

  const errorText = extractUserErrors(data.inventoryActivate);
  if (
    errorText &&
    !errorText.toLowerCase().includes("already") &&
    !errorText.toLowerCase().includes("active")
  ) {
    throw new Error(errorText);
  }

  return data.inventoryActivate?.inventoryLevel || null;
}

function buildMetafields(row) {
  const fields = [
    {
      namespace: "redcliffe",
      key: "test_name",
      type: "single_line_text_field",
      value: row.testName,
    },
    {
      namespace: "redcliffe",
      key: "mrp",
      type: "number_decimal",
      value: String(row.mrp ?? 0),
    },
    {
      namespace: "redcliffe",
      key: "discount_percent",
      type: "number_decimal",
      value: String(row.discount ?? 0),
    },
  ];

  if (row.b2bPrice !== null && row.b2bPrice !== undefined) {
    fields.push({
      namespace: "redcliffe",
      key: "b2b_price",
      type: "number_decimal",
      value: String(row.b2bPrice ?? 0),
    });
  }

  if (row.code) {
    fields.push({
      namespace: "redcliffe",
      key: "code",
      type: "single_line_text_field",
      value: row.code,
    });
  }

  if (row.category) {
    fields.push({
      namespace: "redcliffe",
      key: "category",
      type: "single_line_text_field",
      value: row.category,
    });
  }

  return fields;
}

function findExistingVariant(product, row) {
  const variants = (product.variants?.edges || []).map(({ node }) => node);
  const byCode = row.code
    ? variants.find((variant) => variantKey(variant.sku) === variantKey(row.code))
    : null;
  if (byCode) return byCode;

  return variants.find((variant) => {
    const optionValue = variant.selectedOptions?.[0]?.value || variant.title;
    return variantKey(optionValue) === variantKey(row.testName);
  });
}

function getPrimaryOptionName(product) {
  return normalizeText(product?.options?.[0]?.name) || "Title";
}

async function setInventoryQuantity(inventoryItemId, quantity = REDCLIFFE_DEFAULT_INVENTORY) {
  if (!inventoryItemId) return null;
  const locationId = await getFirstLocationId();
  if (!locationId) return null;

  const mutation = `
    mutation InventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          reason
          changes {
            name
            delta
            quantityAfterChange
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, {
    input: {
      ignoreCompareQuantity: true,
      name: "available",
      reason: "correction",
      referenceDocumentUri: `redcliffe-price-dashboard://${Date.now()}`,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity,
          compareQuantity: null,
        },
      ],
    },
  });

  const errorText = extractUserErrors(data.inventorySetQuantities);
  if (errorText) {
    if (errorText.toLowerCase().includes("not stocked")) {
      await activateInventoryAtLocation(inventoryItemId, locationId, quantity);
      return data.inventorySetQuantities?.inventoryAdjustmentGroup || null;
    }
    throw new Error(errorText);
  }

  return data.inventorySetQuantities?.inventoryAdjustmentGroup || null;
}

async function upsertRedcliffeVariant(rawRow) {
  const row = normalizePriceRow(rawRow);
  const product = await getRedcliffeProduct();
  const existingVariant = findExistingVariant(product, row);
  const compareAtPrice = row.mrp && row.mrp > row.ourPrice ? moneyString(row.mrp) : null;
  const price = moneyString(row.ourPrice);

  if (existingVariant) {
    const optionName = getPrimaryOptionName(product);
    const mutation = `
      mutation RedcliffeVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            title
            price
            compareAtPrice
            inventoryQuantity
            inventoryItem {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await shopifyGraphQL(mutation, {
      productId: product.id,
      variants: [
        {
          id: existingVariant.id,
          price,
          compareAtPrice,
          inventoryItem: row.code ? { sku: row.code } : undefined,
          optionValues: [
            {
              optionName,
              name: row.testName,
            },
          ],
          metafields: buildMetafields(row),
        },
      ],
    });
    const payload = data.productVariantsBulkUpdate;
    const errorText = extractUserErrors(payload);
    if (errorText) throw new Error(errorText);
    const updated = payload.productVariants?.[0];
    await setInventoryQuantity(
      updated?.inventoryItem?.id || existingVariant.inventoryItem?.id,
      REDCLIFFE_DEFAULT_INVENTORY
    );
    return {
      action: "updated",
      row,
      variant: updated,
    };
  }

  const mutation = `
    mutation RedcliffeVariantCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants {
          id
          title
          price
          compareAtPrice
          inventoryQuantity
          inventoryItem {
            id
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const locationId = await getFirstLocationId();
  const optionName = getPrimaryOptionName(product);
  const variantInput = {
    price,
    compareAtPrice,
    inventoryPolicy: "DENY",
    inventoryItem: row.code ? { sku: row.code, tracked: true } : { tracked: true },
    optionValues: [
      {
        optionName,
        name: row.testName,
      },
    ],
    metafields: buildMetafields(row),
  };

  if (locationId) {
    variantInput.inventoryQuantities = [
      {
        locationId,
        availableQuantity: REDCLIFFE_DEFAULT_INVENTORY,
      },
    ];
  }

  const data = await shopifyGraphQL(mutation, {
    productId: product.id,
    variants: [variantInput],
  });
  const payload = data.productVariantsBulkCreate;
  const errorText = extractUserErrors(payload);
  if (errorText) throw new Error(errorText);

  const created = payload.productVariants?.[0];
  if (!locationId) {
    await setInventoryQuantity(
      created?.inventoryItem?.id,
      REDCLIFFE_DEFAULT_INVENTORY
    );
  }

  return {
    action: "created",
    row,
    variant: created,
  };
}

router.get("/products", async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 50);
    const includeAllVariants = String(req.query.includeAllVariants || "").toLowerCase() === "true";

    const query = `
      query GetProducts($first: Int!, $search: String) {
        products(first: $first, query: $search, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              legacyResourceId
              title
              handle
              status
              featuredImage {
                url
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    legacyResourceId
                    title
                    displayName
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                    availableForSale
                    selectedOptions {
                      name
                      value
                    }
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(query, {
      first: limit,
      search: search || null,
    });

    const products = (data.products.edges || []).map(({ node }) => ({
      id: node.id,
      productId: String(node.legacyResourceId || ""),
      title: node.title,
      handle: node.handle,
      status: node.status,
      image: node.featuredImage?.url || "",
      variants: (node.variants?.edges || []).map(({ node: variant }) => ({
        id: variant.id,
        variantId: String(variant.legacyResourceId || ""),
        title: variant.title,
        displayName: variant.displayName,
        sku: variant.sku || "",
        price: variant.price || "0",
        compareAtPrice: variant.compareAtPrice || "",
        inventoryQuantity: variant.inventoryQuantity ?? 0,
        availableForSale: Boolean(variant.availableForSale),
        image: variant.image?.url || node.featuredImage?.url || "",
        selectedOptions: (variant.selectedOptions || []).map((x) => ({
          name: x.name,
          value: x.value,
        })),
      })),
    }));

    if (includeAllVariants) {
      for (const product of products) {
        if (String(product.productId) !== String(REDCLIFFE_PRICE_PRODUCT_ID)) continue;
        const allVariants = await getProductVariantsBasic(product.productId);
        if (allVariants.length) product.variants = allVariants;
      }
    }

    return res.json({
      ok: true,
      products,
    });
  } catch (error) {
    console.error("shopify products route error:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      message:
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        "Failed to fetch Shopify products",
    });
  }
});

router.get("/redcliffe-price-product", async (_req, res) => {
  try {
    const product = await getRedcliffeProduct();
    return res.json({
      ok: true,
      product: {
        id: product.id,
        productId: String(product.legacyResourceId || ""),
        title: product.title,
        handle: product.handle,
        options: product.options || [],
        variants: (product.variants?.edges || []).map(({ node }) => mapVariant(node)),
      },
      defaultInventory: REDCLIFFE_DEFAULT_INVENTORY,
    });
  } catch (error) {
    console.error("redcliffe price product error:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      message: error.message || "Failed to fetch Redcliffe Shopify product",
    });
  }
});

router.post("/redcliffe-price-variants", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows)
      ? req.body.rows
      : req.body?.row
        ? [req.body.row]
        : [req.body || {}];

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: "At least one variant row is required",
      });
    }

    const results = [];
    for (const row of rows) {
      try {
        results.push({
          ok: true,
          ...(await upsertRedcliffeVariant(row)),
        });
      } catch (error) {
        results.push({
          ok: false,
          row,
          message: error.message || "Failed to save variant",
        });
      }
    }

    const failed = results.filter((item) => !item.ok);
    return res.status(failed.length ? 207 : 200).json({
      ok: failed.length === 0,
      saved: results.length - failed.length,
      failed: failed.length,
      results,
    });
  } catch (error) {
    console.error("redcliffe price variant save error:", error.response?.data || error.message);
    return res.status(500).json({
      ok: false,
      message: error.message || "Failed to save Redcliffe variants",
    });
  }
});

module.exports = router;
