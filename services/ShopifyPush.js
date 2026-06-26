const express = require("express");
const axios = require("axios");
const router = express.Router();

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function cleanString(value) {
  return String(value || "").trim();
}

function pickValue(...values) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function normalizeAddress(address = {}) {
  return {
    firstName: pickValue(address.firstName, address.first_name),
    lastName: pickValue(address.lastName, address.last_name),
    email: pickValue(address.email),
    address1: pickValue(address.address1),
    address2: pickValue(address.address2),
    city: pickValue(address.city),
    province: pickValue(address.province, address.state),
    country: pickValue(address.country, "India"),
    zip: pickValue(address.zip, address.pincode),
    phone: pickValue(address.phone),
  };
}

function normalizePhone(value) {
  const cleaned = cleanString(value);
  const digits = cleaned.replace(/\D/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return cleaned;
}

async function createShopifyOrder(input = {}) {
  const {
    cartItems,
    shippingAddress,
    billingAddress, 
    customer,
    email,
    phone,
    paymentStatus,  
 
    paymentMode, 
    partialPaidAmount,
    orderTotal,

    transactionId,
    customerId,
    shippingCost,
    appliedDiscount,
    note,
  } = input;

  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
 
  const mode = String(paymentMode || "").trim();
  const isPartial = mode === "Partial Paid";
  const isCOD = mode === "COD" || (!mode && paymentStatus === "COD");
  const isPrepaid = mode === "Prepaid" || (!mode && paymentStatus !== "COD");
  const normalizedShippingAddress = normalizeAddress(shippingAddress);
  const normalizedBillingAddress = normalizeAddress(billingAddress);
  const customerPayload = {
    firstName: pickValue(customer?.firstName, customer?.first_name, normalizedShippingAddress.firstName, normalizedBillingAddress.firstName),
    lastName: pickValue(customer?.lastName, customer?.last_name, normalizedShippingAddress.lastName, normalizedBillingAddress.lastName),
    email: pickValue(customer?.email, email, normalizedShippingAddress.email, normalizedBillingAddress.email),
    phone: normalizePhone(pickValue(customer?.phone, phone, normalizedShippingAddress.phone, normalizedBillingAddress.phone)),
  };
 
  if (isPartial) {
    const paid = toNumber(partialPaidAmount);
    const total = toNumber(orderTotal);

    if (!paid || paid <= 0) {
      throw validationError("partialPaidAmount is required and must be > 0");
    }
    if (!total || total <= 0) {
      throw validationError("orderTotal is required and must be > 0 for Partial Paid");
    }
    if (paid >= total) {
      throw validationError("partialPaidAmount must be less than orderTotal");
    }
    if (!transactionId || String(transactionId).trim() === "") {
      throw validationError("transactionId is required for Partial Paid");
    }
  }

  const orderPayload = {
    order: {
      line_items: (cartItems || []).map((item) => ({
        variant_id: item.variantId,
        quantity: item.quantity,
      })),
      email: customerPayload.email || undefined,
      phone: customerPayload.phone || undefined,
      shipping_address: {
        first_name: normalizedShippingAddress.firstName || customerPayload.firstName,
        last_name: normalizedShippingAddress.lastName || customerPayload.lastName,
        address1: normalizedShippingAddress.address1,
        address2: normalizedShippingAddress.address2,
        city: normalizedShippingAddress.city,
        province: normalizedShippingAddress.province,
        country: normalizedShippingAddress.country,
        zip: normalizedShippingAddress.zip,
        phone: normalizedShippingAddress.phone || customerPayload.phone,
      },
      billing_address: {
        first_name: normalizedBillingAddress.firstName || customerPayload.firstName,
        last_name: normalizedBillingAddress.lastName || customerPayload.lastName,
        address1: normalizedBillingAddress.address1 || normalizedShippingAddress.address1,
        address2: normalizedBillingAddress.address2 || normalizedShippingAddress.address2,
        city: normalizedBillingAddress.city || normalizedShippingAddress.city,
        province: normalizedBillingAddress.province || normalizedShippingAddress.province,
        country: normalizedBillingAddress.country || normalizedShippingAddress.country,
        zip: normalizedBillingAddress.zip || normalizedShippingAddress.zip,
        phone: normalizedBillingAddress.phone || normalizedShippingAddress.phone || customerPayload.phone,
      },
      shipping_lines: [],
      discount_codes: [],
 
      financial_status: isPartial ? "partially_paid" : isPrepaid ? "paid" : "pending",

      note_attributes: [],
      note: String(note || "").trim(),
      tags: isPartial ? "PARTIAL_COD" : isCOD ? "COD" : "PREPAID",
      transactions: [],
    },
  };
 
  if (transactionId) {
    orderPayload.order.note_attributes.push({
      name: "transaction_id",
      value: String(transactionId),
    });
  }

  if (isPartial) {
    const paid = toNumber(partialPaidAmount);
    const total = toNumber(orderTotal);
    const remaining = Math.max(0, total - paid);

    orderPayload.order.note_attributes.push(
      { name: "payment_mode", value: "Partial Paid" },
      { name: "partial_paid_amount", value: paid.toFixed(2) },
      { name: "remaining_cod_amount", value: remaining.toFixed(2) }
    );

    orderPayload.order.transactions.push({
      kind: "sale",
      status: "success",
      amount: paid.toFixed(2),
      gateway: "manual",
      authorization: String(transactionId || ""),
    });
  }
 
  if (shippingCost && toNumber(shippingCost) > 0) {
    orderPayload.order.shipping_lines.push({
      title: "Shipping Charges",
      price: toNumber(shippingCost).toFixed(2),
      code: "SHIPPING",
    });
  }
 
  if (appliedDiscount && toNumber(appliedDiscount) > 0) {
    orderPayload.order.discount_codes.push({
      code: "APPLIED_DISCOUNT",
      amount: toNumber(appliedDiscount).toFixed(2),
      type: "fixed_amount",
    });
  }

  if (customerId) {
    orderPayload.order.customer = { id: customerId };
  } else if (customerPayload.email || customerPayload.phone || customerPayload.firstName || customerPayload.lastName) {
    orderPayload.order.customer = {
      first_name: customerPayload.firstName || undefined,
      last_name: customerPayload.lastName || undefined,
      email: customerPayload.email || undefined,
      phone: customerPayload.phone || undefined,
    };
  }

  const createOrderUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders.json`;

  // 1) Create order
  const response = await axios.post(createOrderUrl, orderPayload, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  return response.data.order;
}

// POST /create-order endpoint
router.post("/create-order", async (req, res) => {
  try {
    const createdOrder = await createShopifyOrder(req.body);
    return res.status(201).json({
      message: "Order created successfully",
      order: createdOrder,
    });
  } catch (error) {
    console.error("Error creating order:", error.response?.data || error.message);
    return res.status(error.statusCode || 500).json({
      message: "Error creating order",
      error: error.response?.data || error.message,
    });
  }
});

const getPhoneDigits = (value = "") => String(value || "").replace(/\D/g, "");
const getLastTenDigits = (value = "") => getPhoneDigits(value).slice(-10);
const formatIndianPhone = (value = "") => {
  const lastTen = getLastTenDigits(value);
  return lastTen.length === 10 ? `+91${lastTen}` : "";
};

const collectCustomerPhones = (customer = {}) => {
  const phones = [];
  if (customer.phone) phones.push(customer.phone);
  if (customer.default_address?.phone) phones.push(customer.default_address.phone);
  (customer.addresses || []).forEach((address) => {
    if (address?.phone) phones.push(address.phone);
  });
  return phones;
};

const buildPhoneSearchQueries = (phone = "") => {
  const digits = getPhoneDigits(phone);
  const lastTen = getLastTenDigits(phone);
  return Array.from(
    new Set(
      [
        phone,
        digits,
        lastTen.length === 10 ? lastTen : "",
        lastTen.length === 10 ? `+91${lastTen}` : "",
        lastTen.length === 10 ? `91${lastTen}` : "",
        lastTen.length === 10 ? `+1${lastTen}` : "",
        lastTen.length === 10 ? `1${lastTen}` : "",
      ].filter(Boolean)
    )
  );
};

async function searchShopifyCustomersByPhone(phone, headers) {
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const lastTen = getLastTenDigits(phone);
  const seen = new Set();
  const matches = [];

  for (const query of buildPhoneSearchQueries(phone)) {
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
      query
    )}`;
    const response = await axios.get(url, { headers });
    const customers = response.data.customers || [];

    customers.forEach((customer) => {
      if (!customer?.id || seen.has(customer.id)) return;

      const customerPhones = collectCustomerPhones(customer);
      const matchingPhone = customerPhones.find(
        (customerPhone) => getLastTenDigits(customerPhone) === lastTen
      );

      if (matchingPhone || !lastTen) {
        seen.add(customer.id);
        matches.push({ customer, matchingPhone: matchingPhone || customer.phone || "" });
      }
    });

    if (matches.length) break;
  }

  return matches;
}

const buildCountryCodeFix = (customer, matchingPhone, requestedPhone) => {
  const requestedLastTen = getLastTenDigits(requestedPhone);
  const matchingDigits = getPhoneDigits(matchingPhone);

  if (
    requestedLastTen.length !== 10 ||
    matchingDigits !== `1${requestedLastTen}` ||
    String(matchingPhone || "").includes("+91")
  ) {
    return null;
  }

  return {
    customerId: customer.id,
    currentPhone: matchingPhone,
    suggestedPhone: `+91${requestedLastTen}`,
  };
};

// GET /customer endpoint to search for an existing customer by phone
router.get("/customer", async (req, res) => {
  const { phone } = req.query;
  const accessToken = process.env.SHOPIFY_API_SECRET;

  if (!phone) {
    return res.status(400).json({ message: "phone is required" });
  }

  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  try {
    const matches = await searchShopifyCustomersByPhone(phone, headers);
    const match = matches[0];

    if (!match) {
      return res.json({});
    }

    const countryCodeFix = buildCountryCodeFix(
      match.customer,
      match.matchingPhone,
      phone
    );

    return res.json({
      ...match.customer,
      countryCodeFix,
    });
  } catch (error) {
    console.error("Error fetching customer:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error fetching customer",
      error: error.response?.data || error.message,
    });
  }
});

router.put("/customer-phone-country-code", async (req, res) => {
  const { customerId, phone } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
  const suggestedPhone = formatIndianPhone(phone);

  if (!customerId || !suggestedPhone) {
    return res.status(400).json({
      message: "customerId and valid 10-digit phone are required",
    });
  }

  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  try {
    const customerUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${customerId}.json`;
    const customerResponse = await axios.get(customerUrl, { headers });
    const customer = customerResponse.data.customer;

    if (!customer?.id) {
      return res.status(404).json({ message: "Customer not found on Shopify" });
    }

    const lastTen = getLastTenDigits(suggestedPhone);
    const customerPhones = collectCustomerPhones(customer);
    const hasPlusOneMatch = customerPhones.some(
      (customerPhone) => getPhoneDigits(customerPhone) === `1${lastTen}`
    );

    if (!hasPlusOneMatch) {
      return res.status(400).json({
        message: "This customer does not have a matching +1 phone to update.",
      });
    }

    const updateResponse = await axios.put(
      customerUrl,
      {
        customer: {
          id: customer.id,
          phone: suggestedPhone,
        },
      },
      { headers }
    );

    const addressUpdates = (customer.addresses || [])
      .filter((address) => getPhoneDigits(address?.phone) === `1${lastTen}`)
      .map((address) => {
        const addressUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${customer.id}/addresses/${address.id}.json`;
        return axios.put(
          addressUrl,
          {
            address: {
              id: address.id,
              phone: suggestedPhone,
            },
          },
          { headers }
        );
      });

    await Promise.all(addressUpdates);

    res.status(200).json({
      message: "Customer phone updated successfully",
      customer: updateResponse.data.customer,
      updatedPhone: suggestedPhone,
      updatedAddressCount: addressUpdates.length,
    });
  } catch (error) {
    console.error("Error updating customer phone:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: "Error updating customer phone",
      error: error.response?.data || error.message,
    });
  }
});

// POST /create-customer endpoint to create a new customer on Shopify
router.post("/create-customer", async (req, res) => {
  const { phone, first_name, last_name } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;

  if (!phone || !String(first_name || "").trim() || !String(last_name || "").trim()) {
    return res.status(400).json({
      message: "phone, first_name and last_name are required",
    });
  }

  try {
    const headers = {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    };
    const searchUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/search.json?query=phone:${encodeURIComponent(
      phone
    )}`;
    const existingResponse = await axios.get(searchUrl, { headers });
    const existingCustomer = existingResponse.data.customers?.[0];

    if (existingCustomer?.id) {
      const updateUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${existingCustomer.id}.json`;
      const updatePayload = {
        customer: {
          id: existingCustomer.id,
          first_name,
          last_name,
          phone,
        },
      };
      const updatedResponse = await axios.put(updateUrl, updatePayload, {
        headers,
      });

      return res.status(200).json({
        message: "Customer updated successfully",
        customer: updatedResponse.data.customer,
      });
    }

    const createUrl = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers.json`;
    const createPayload = {
      customer: {
        first_name,
        last_name,
        phone,
      },
    };
    const response = await axios.post(createUrl, createPayload, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    res.status(201).json({
      message: "Customer created successfully",
      customer: response.data.customer,
    });
  } catch (error) {
    console.error("Error creating customer:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.errors
        ? "Unable to save customer on Shopify"
        : "Error creating customer",
      error: error.response?.data || error.message,
    });
  }
});

router.get("/customer-orders", async (req, res) => {
  res.json({ addresses: [] });
});

router.post("/update-order-note", async (req, res) => {
  const { orderId, note } = req.body;
  const shopifyStore = process.env.SHOPIFY_STORE_NAME;
  const accessToken = process.env.SHOPIFY_API_SECRET;
  const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/orders/${orderId}.json`;

  try {
    const response = await axios.put(
      url,
      { order: { id: orderId, note } },
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    res.status(200).json({
      message: "Order note updated successfully",
      order: response.data.order,
    });
  } catch (error) {
    console.error("Error updating order note:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error updating order note",
      error: error.response?.data || error.message,
    });
  }
});

// PUT /customer-address
router.put("/customer-address", async (req, res) => {
  const {
    customerId,
    addressId,
    first_name,
    last_name,
    phone,
    address1,
    address2,
    city,
    province,
    country,
    zip,
  } = req.body;

  try {
    const shopifyStore = process.env.SHOPIFY_STORE_NAME;
    const accessToken = process.env.SHOPIFY_API_SECRET;
    const url = `https://${shopifyStore}.myshopify.com/admin/api/2024-04/customers/${customerId}/addresses/${addressId}.json`;

    const payload = {
      address: {
        id: addressId,
        first_name,
        last_name,
        phone,
        address1,
        address2,
        city,
        province,
        country,
        zip,
      },
    };

    const response = await axios.put(url, payload, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    res.status(200).json({
      message: "Address updated successfully",
      address: response.data.customer_address,
    });
  } catch (error) {
    console.error("Error updating customer address:", error.response?.data || error.message);
    res.status(500).json({
      message: "Error updating customer address",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
module.exports.createShopifyOrder = createShopifyOrder;
