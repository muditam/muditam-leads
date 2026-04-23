const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const MyOrder = require("../models/MyOrder");
const ShopifyOrder = require("../models/ShopifyOrder");


function safeStr(v) {
 return String(v ?? "").trim();
}


function digitsOnly(v = "") {
 return String(v || "").replace(/\D/g, "");
}


function last10(v = "") {
 return digitsOnly(v).slice(-10);
}


function byLast10Regex(phone10) {
 return new RegExp(`${phone10}$`);
}


function pickOrderDate(value) {
 const dt = value ? new Date(value) : null;
 if (!dt || Number.isNaN(dt.getTime())) return null;
 return dt;
}


function formatDate(value) {
 const dt = pickOrderDate(value);
 if (!dt) return "";
 return dt.toISOString().slice(0, 10);
}


function summarizeOrder(order = {}) {
 const orderId =
   safeStr(order.order_id) ||
   safeStr(order.orderId) ||
   safeStr(order.orderName) ||
   "";


 const status =
   safeStr(order.shipment_status) ||
   safeStr(order.deliveryStatus) ||
   safeStr(order.fulfillment_status) ||
   safeStr(order.financial_status) ||
   safeStr(order.paymentStatus) ||
   "";


 const amount =
   Number(order.amount || order.totalPrice || 0) > 0
     ? Number(order.amount || order.totalPrice || 0)
     : null;


 const when =
   formatDate(order.order_date) ||
   formatDate(order.orderDate) ||
   formatDate(order.shopifyCreatedAt) ||
   formatDate(order.createdAt) ||
   "";


 const product =
   safeStr(order.productOrdered) ||
   safeStr(order.productsOrdered?.[0]?.title) ||
   safeStr(order.productsOrdered?.[0]) ||
   "";


 return {
   orderId,
   status,
   amount,
   when,
   product,
 };
}


function summarizeLead(lead = null) {
 if (!lead) return null;
 return {
   id: String(lead._id || ""),
   name: safeStr(lead.name),
   leadStatus: safeStr(lead.leadStatus),
   salesStatus: safeStr(lead.salesStatus),
   deliveryStatus: safeStr(lead.deliveryStatus),
   orderId: safeStr(lead.orderId),
   nextFollowup: safeStr(lead.nextFollowup),
   lastOrderDate: safeStr(lead.lastOrderDate),
   agentAssigned: safeStr(lead.agentAssigned),
   healthExpertAssigned: safeStr(lead.healthExpertAssigned),
 };
}


function summarizeCustomer(customer = null) {
 if (!customer) return null;
 return {
   id: String(customer._id || ""),
   name: safeStr(customer.name),
   leadStatus: safeStr(customer.leadStatus),
   subLeadStatus: safeStr(customer.subLeadStatus),
   assignedTo: safeStr(customer.assignedTo),
   lookingFor: safeStr(customer.lookingFor),
   followUpDate: formatDate(customer.followUpDate),
 };
}


function compactOrders(orders = [], max = 5) {
 return (orders || [])
   .map((o) => summarizeOrder(o))
   .filter((o) => o.orderId || o.status || o.when)
   .slice(0, max);
}


function buildContextText({
 phone10 = "",
 lead = null,
 customer = null,
 orderSummary = [],
}) {
 const lines = [];
 lines.push(`Customer phone: ${phone10 || "unknown"}`);


 if (lead) {
   lines.push(
     `Lead: ${lead.name || "NA"} | leadStatus=${lead.leadStatus || "NA"} | salesStatus=${lead.salesStatus || "NA"} | deliveryStatus=${lead.deliveryStatus || "NA"} | orderId=${lead.orderId || "NA"}`
   );
 }


 if (customer) {
   lines.push(
     `Customer profile: ${customer.name || "NA"} | leadStatus=${customer.leadStatus || "NA"} | assignedTo=${customer.assignedTo || "NA"} | lookingFor=${customer.lookingFor || "NA"}`
   );
 }


 if ((orderSummary || []).length) {
   lines.push("Recent orders:");
   for (const o of orderSummary) {
     lines.push(
       `- ${o.orderId || "NA"} | status=${o.status || "NA"} | date=${o.when || "NA"} | amount=${o.amount != null ? o.amount : "NA"} | product=${o.product || "NA"}`
     );
   }
 } else {
   lines.push("Recent orders: none found.");
 }


 return lines.join("\n");
}


async function getCustomerContextByPhone(phoneInput = "") {
 const phone10 = last10(phoneInput);
 if (!phone10) {
   return {
     found: false,
     phone10: "",
     lead: null,
     customer: null,
     orders: [],
     contextText: "Customer context unavailable: invalid phone.",
   };
 }


 const phoneRegex = byLast10Regex(phone10);


 const [lead, customer, orders, myOrders, shopifyOrders] = await Promise.all([
   Lead.findOne({ contactNumber: phoneRegex })
     .sort({ _id: -1 })
     .select(
       "name contactNumber leadStatus salesStatus deliveryStatus orderId nextFollowup lastOrderDate agentAssigned healthExpertAssigned"
     )
     .lean(),
   Customer.findOne({ phone: phoneRegex })
     .sort({ _id: -1 })
     .select("name phone leadStatus subLeadStatus assignedTo lookingFor followUpDate")
     .lean(),
   Order.find({ contact_number: phoneRegex })
     .sort({ order_date: -1, last_updated_at: -1, _id: -1 })
     .limit(3)
     .select("order_id shipment_status order_date last_updated_at contact_number")
     .lean(),
   MyOrder.find({ phone: phoneRegex })
     .sort({ orderDate: -1, _id: -1 })
     .limit(3)
     .select("orderId paymentStatus orderDate totalPrice productOrdered phone")
     .lean(),
   ShopifyOrder.find({ normalizedPhone: phone10 })
     .sort({ orderDate: -1, _id: -1 })
     .limit(4)
     .select(
       "orderId orderName shipment_status fulfillment_status financial_status orderDate amount productsOrdered normalizedPhone"
     )
     .lean(),
 ]);


 const orderSummary = compactOrders(
   [...(shopifyOrders || []), ...(orders || []), ...(myOrders || [])],
   6
 );


 const leadSummary = summarizeLead(lead);
 const customerSummary = summarizeCustomer(customer);


 return {
   found: Boolean(leadSummary || customerSummary || orderSummary.length),
   phone10,
   lead: leadSummary,
   customer: customerSummary,
   orders: orderSummary,
   contextText: buildContextText({
     phone10,
     lead: leadSummary,
     customer: customerSummary,
     orderSummary,
   }),
 };
}


module.exports = {
 getCustomerContextByPhone,
};



