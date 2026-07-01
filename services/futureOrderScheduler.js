const FutureOrder = require("../models/FutureOrder");
const MyOrder = require("../models/MyOrder");
const { createShopifyOrder } = require("./ShopifyPush");

const PRODUCT_ABBREVIATIONS = {
  "Karela Jamun Fizz": "KJF",
  "Sugar Defend Pro": "SDP",
  "Vasant Kusmakar Ras": "VKR",
  "Liver Fix": "L-Fx",
  "Stress & Sleep": "S&S",
  "Chandraprabha Vati": "CPV",
  "Heart Defend Pro": "HDP",
  "Performance Forever": "PF",
  "Power Gut": "PGut",
  "Shilajit with Gold": "Shilajit",
  "Diabetes Management Kit": "Kit",
};

let running = false;

function istDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function nextISTDayStart(date = new Date()) {
  const current = new Date(`${istDateString(date)}T00:00:00+05:30`);
  current.setUTCDate(current.getUTCDate() + 1);
  return current;
}

function formatAddress(address = {}) {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.country,
    address.zip,
  ]
    .filter(Boolean)
    .join(", ") || "N/A";
}

function productOrderedText(order = {}) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.length) {
    return lineItems
      .map((item) => PRODUCT_ABBREVIATIONS[item.title] || item.title)
      .filter(Boolean)
      .join(", ") || "N/A";
  }

  const savedItems = Array.isArray(order.cartItems) ? order.cartItems : [];
  return savedItems
    .map((item) => PRODUCT_ABBREVIATIONS[item.title] || item.sku || item.title)
    .filter(Boolean)
    .join(", ") || "N/A";
}

function buildMyOrderPayload(futureOrder, shopifyOrder) {
  const details = futureOrder.orderDetails || {};
  const shippingAddress = shopifyOrder.shipping_address || futureOrder.shippingAddress || {};
  const customerName = shopifyOrder.customer
    ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
    : futureOrder.customerName || "N/A";
  const paymentMethod = futureOrder.paymentMode || futureOrder.shopifyOrderPayload?.paymentMode || "";
  const isPartial = paymentMethod === "Partial Paid";
  const totalPrice = Number(details.upsellAmount || 0) > 0
    ? Number(details.upsellAmount || 0)
    : Number(shopifyOrder.total_price || futureOrder.orderTotal || 0);

  return {
    customerName,
    phone: shippingAddress.phone || futureOrder.phoneNumber || "N/A",
    shippingAddress: formatAddress(shippingAddress),
    paymentStatus: shopifyOrder.financial_status || futureOrder.paymentStatus || "",
    productOrdered: productOrderedText(shopifyOrder),
    orderDate: futureOrder.createdAt || shopifyOrder.created_at || new Date(),
    orderId: shopifyOrder.name || String(shopifyOrder.id || ""),
    totalPrice,
    agentName: details.agentName || futureOrder.createdBy || "N/A",
    partialPayment: isPartial ? Number(futureOrder.partialPaidAmount || 0) : 0,
    dosageOrdered: details.dosageOrdered || "10-Days",
    selfRemark: details.selfRemark || "",
    paymentMethod,
    upsellAmount: Number(details.upsellAmount || 0),
    transactionId: futureOrder.transactionId || "",
  };
}

async function processFutureOrder(orderId, options = {}) {
  const markAsPaid = Boolean(options.markAsPaid);
  const locked = await FutureOrder.findOneAndUpdate(
    { _id: orderId, status: "pending" },
    {
      $set: { status: "processing", lastAttemptAt: new Date(), lastError: "" },
      $inc: { attempts: 1 },
    },
    { new: true }
  );

  if (!locked) return null;

  let shopifyOrder = null;

  try {
    const shopifyPayload = markAsPaid
      ? {
          ...(locked.shopifyOrderPayload || {}),
          paymentMode: "Prepaid",
          paymentStatus: "paid",
          partialPaidAmount: 0,
        }
      : locked.shopifyOrderPayload || {};

    shopifyOrder = await createShopifyOrder(shopifyPayload);
    const myOrderPayload = buildMyOrderPayload(locked, shopifyOrder);
    let myOrder = locked.myOrderId
      ? await MyOrder.findByIdAndUpdate(locked.myOrderId, myOrderPayload, { new: true })
      : await MyOrder.create(myOrderPayload);
    if (!myOrder) {
      myOrder = await MyOrder.create(myOrderPayload);
    }

    locked.status = "placed";
    locked.placedAt = new Date();
    locked.shopifyOrderId = String(shopifyOrder.id || "");
    locked.shopifyOrderName = String(shopifyOrder.name || "");
    locked.myOrderId = myOrder?._id || locked.myOrderId;
    locked.lastError = "";
    await locked.save();

    return { futureOrder: locked, shopifyOrder, myOrder };
  } catch (error) {
    const message = error.response?.data
      ? JSON.stringify(error.response.data).slice(0, 1000)
      : String(error.message || error).slice(0, 1000);

    if (shopifyOrder?.id) {
      await FutureOrder.updateOne(
        { _id: locked._id },
        {
          $set: {
            status: "placed",
            placedAt: new Date(),
            shopifyOrderId: String(shopifyOrder.id || ""),
            shopifyOrderName: String(shopifyOrder.name || ""),
            lastError: `Shopify order was created, but local save failed: ${message}`,
            lastAttemptAt: new Date(),
          },
        }
      );
      return {
        futureOrder: await FutureOrder.findById(locked._id),
        shopifyOrder,
        myOrder: null,
        warning: message,
      };
    }

    await FutureOrder.updateOne(
      { _id: locked._id },
      { $set: { status: "pending", lastError: message, lastAttemptAt: new Date() } }
    );
    throw error;
  }
}

async function runDueFutureOrders({ limit = 20 } = {}) {
  if (running) return { skipped: true, processed: 0, failed: 0 };
  running = true;

  try {
    const dueBefore = nextISTDayStart();
    const rows = await FutureOrder.find({
      status: "pending",
      scheduledDate: { $lt: dueBefore },
    })
      .sort({ scheduledDate: 1, createdAt: 1 })
      .limit(limit)
      .select("_id")
      .lean();

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await processFutureOrder(row._id);
        processed += 1;
      } catch (error) {
        failed += 1;
        console.error("Future order processing failed:", row._id, error.response?.data || error.message);
      }
    }

    return { processed, failed };
  } finally {
    running = false;
  }
}

module.exports = {
  runDueFutureOrders,
  processFutureOrder,
};
