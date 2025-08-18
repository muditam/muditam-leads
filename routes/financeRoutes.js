const express = require("express");
const router = express.Router();
const axios = require("axios");
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder");

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_NAME = process.env.SHOPIFY_STORE_NAME;

/**
 * Recursively fetch all Shopify orders for a given date range
 */
const fetchAllShopifyOrders = async (startDate, endDate) => {
  let orders = [];
  let baseUrl = `https://${SHOPIFY_STORE_NAME}.myshopify.com/admin/api/2023-07/orders.json?status=any&limit=250`; 
  if (startDate) baseUrl += `&created_at_min=${new Date(startDate).toISOString()}`;
  if (endDate) baseUrl += `&created_at_max=${new Date(endDate).toISOString()}`;

  let nextUrl = baseUrl; 

  try {
    while (nextUrl) {
      const res = await axios.get(nextUrl, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        },
      });

      orders.push(...res.data.orders);

      const linkHeader = res.headers["link"];
      const nextLink = linkHeader?.split(",").find((s) => s.includes('rel="next"'));
      if (nextLink) {
        const match = nextLink.match(/<([^>]+)>/);
        nextUrl = match?.[1] || null;
      } else {
        nextUrl = null;
      }
    }

    return orders;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error("Shopify API rate limit hit (429)");
    } else {
      console.error("Error fetching Shopify orders:", err.message);
    }
    return [];
  }
};

router.get("/orders", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const skip = (page - 1) * limit;

  // Default to Last 7 Days
  let { startDate, endDate } = req.query;
  if (!startDate || startDate === "null" || !endDate || endDate === "null") {
    const now = new Date();
    const past = new Date();
    past.setDate(now.getDate() - 6);
    startDate = past.toISOString();
    endDate = now.toISOString();
  }

  try {
    const allOrders = await fetchAllShopifyOrders(startDate, endDate);
    const totalCount = allOrders.length;
    const paginatedOrders = allOrders.slice(skip, skip + limit);

    const enrichedOrders = await Promise.all(
      paginatedOrders.map(async (shopOrder) => {
        const orderName = shopOrder.name; // e.g. "#4567"
        const cleanedOrderId = orderName.replace("#", ""); 

        const orderDoc = await Order.findOne({ order_id: cleanedOrderId });
        const myOrderDoc = await MyOrder.findOne({ orderId: orderName });

        const phone =
          myOrderDoc?.phone ||
          shopOrder?.customer?.phone ||
          shopOrder?.billing_address?.phone ||
          "--";

        const deliveredDate =
          orderDoc?.shipment_status === "Delivered"
            ? orderDoc?.last_updated_at
            : null;

        const totalPrice = parseFloat(shopOrder.total_price || 0);
        const partialPayment = parseFloat(myOrderDoc?.partialPayment || 0);
        const upsellAmount = parseFloat(myOrderDoc?.upsellAmount || 0);
        const totalReceived = partialPayment + upsellAmount;
        const remainingAmount = totalPrice - totalReceived;

        const lmsNote =
          shopOrder.note_attributes?.find((attr) => attr.name === "transaction_id")?.value || "";

        return {
          createdAt: shopOrder.created_at,
          orderName,
          trackingId: orderDoc?.tracking_number || "--",
          billingName:
            myOrderDoc?.customerName ||
            shopOrder.customer?.first_name ||
            "Unknown",
          phone, 
          orderStatus: orderDoc?.shipment_status || "Pending",
          financialStatus: shopOrder.financial_status,
          paymentMethod:
            myOrderDoc?.paymentMethod ||
            shopOrder?.payment_gateway_names?.[0] ||
            shopOrder?.gateway ||
            "--",
          totalPrice,
          lmsNote,
          utr: "",
          courierPartner: orderDoc?.carrier_title || "--",
          customOrderStatus: "open",
          partialPayment,
          deliveredDate,
          totalReceived,
          remainingAmount,
          refund: "",
          settlementDate: "",
          remark: "",
        };
      })
    );

    res.status(200).json({
      orders: enrichedOrders,
      totalCount,
    });
  } catch (err) {
    console.error("Error in /api/finance/orders:", err.message);
    res.status(500).json({ error: "Failed to fetch finance orders" });
  }
});

module.exports = router;

