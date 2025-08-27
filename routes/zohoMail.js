// routes/zohoMail.js
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const fs = require("fs");
const FormData = require("form-data");
const Order = require("../models/Order");

const router = express.Router();

const DC = process.env.ZOHO_DC || "in"; // "in" | "com" | "eu"
const ACCOUNTS_BASE = `https://accounts.zoho.${DC}`;
const MAIL_BASE = `https://mail.zoho.${DC}`;

let cachedAccountId = process.env.ZOHO_ACCOUNT_ID || null;
let refreshing = null;

/* ---------------- Auth helpers ---------------- */
async function refreshAccessToken() {
  if (refreshing) return refreshing;
  const { REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET } = process.env;
  if (!REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET in env");
  }
  const params = new URLSearchParams({
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  refreshing = axios
    .post(`${ACCOUNTS_BASE}/oauth/v2/token`, params)
    .then(({ data }) => {
      if (!data.access_token) throw new Error("No access_token from Zoho refresh");
      process.env.ZOHO_ACCESS_TOKEN = data.access_token;
      refreshing = null;
      return data.access_token;
    })
    .catch((e) => {
      refreshing = null;
      throw e;
    });
  return refreshing;
}

async function withZohoToken(fn) {
  const token = process.env.ZOHO_ACCESS_TOKEN || (await refreshAccessToken());
  try {
    return await fn(token);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      const fresh = await refreshAccessToken();
      return await fn(fresh);
    }
    throw err;
  }
}

async function getAccountId(token) {
  if (cachedAccountId) return cachedAccountId;
  const { data } = await axios.get(`${MAIL_BASE}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const id = data?.data?.[0]?.accountId;
  if (!id) throw new Error("Unable to determine Zoho accountId");
  cachedAccountId = id;
  return id;
}

/* ---------------- Utils ---------------- */
function render(template, v) {
  if (!template) return "";
   const vars = Object.fromEntries(
     Object.entries(v || {}).map(([k, val]) => [String(k).toLowerCase(), val ?? ""])
   );
  // also alias common synonyms
   if (vars["order_id"] && !vars["order id"]) vars["order id"] = vars["order_id"];
   if (vars["tracking_number"] && !vars["awb"]) vars["awb"] = vars["tracking_number"];
   if (vars["order_date"] && !vars["order date"]) vars["order date"] = vars["order_date"];
   if (vars["agent_name"] && !vars["agent name"]) vars["agent name"] = vars["agent_name"];
 
   let out = String(template);
   // {{ token }}
   out = out.replace(/{{\s*([^}]+)\s*}}/gi, (_, raw) => {
     const key = String(raw).trim().toLowerCase();
     return vars[key] ?? "";
   });
   // { token } (legacy)
   out = out.replace(/{\s*([^}]+)\s*}/gi, (_, raw) => {
     const key = String(raw).trim().toLowerCase();
     return vars[key] ?? "";
   });
   return out;
 }

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupUploads(files = []) {
  files.forEach((f) => f?.path && fs.unlink(f.path, () => {}));
}

const SUBJECT_TEMPLATES = {
   fakeRemark: "Escalation – Fake Delivery Remark | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   notReceived: "Urgent – Wrong Delivery Status | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   delayed: "Delay in Delivery | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   doorstep: "Request for Doorstep Delivery | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   wrongOtp: "Escalation – Wrong OTP Taken | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   codToPrepaid: "Request for Payment Mode Change | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   rto: "Request for RTO | Order ID {{Order_ID}} | AWB {{tracking_number}}",
   urgentDelivery: "Urgent Delivery Required | Order ID {{Order_ID}} | AWB {{tracking_number}}",
 };

const CONTENT_TEMPLATES = {
   fakeRemark:
     "Dear Team,\nThe tracking for AWB {{tracking_number}} shows Fake Remark, which is incorrect. Customer wants the Shipment on priority basis. Kindly deliver at the earliest.\nRegards,\n{{Agent_Name}}",
   notReceived:
     "Dear Team,\nAWB {{tracking_number}} is marked delivered, but the consignee has not received it. Please check and resolve urgently.\nRegards,\n{{Agent_Name}}",
   delayed:
     "Dear Team,\nAWB {{tracking_number}} dispatched on {{order date}} has crossed the expected delivery time. Kindly arrange delivery without further delay.\nRegards,\n{{Agent_Name}}",
   doorstep:
     "Dear Team,\nKindly ensure AWB {{tracking_number}} is delivered at the customer’s doorstep as committed. Please arrange delivery on priority.\nRegards,\n{{Agent_Name}}",
   wrongOtp:
     "Dear Team,\nFor AWB {{tracking_number}}, the courier boy took OTP from the customer under false pretext for cancellation. Please investigate and reattempt delivery immediately.\nRegards,\n{{Agent_Name}}",
   codToPrepaid:
     "Dear Team,\nPlease change the payment mode for AWB {{tracking_number}} from COD to Prepaid and process delivery accordingly.\nRegards,\n{{Agent_Name}}",
   rto:
     "Dear Team,\nPlease initiate RTO for AWB {{tracking_number}} and confirm once updated in the system.\nRegards,\n{{Agent_Name}}",
   urgentDelivery:
     "Dear Team,\nThis shipment AWB {{tracking_number}} is critical. Kindly ensure delivery to the customer today without fail.\nRegards,\n{{Agent_Name}}",
 };

// Normalize "Name <email@x>" → "email@x"
function toEmail(s = "") {
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/* ---------------- Small Zoho helpers ---------------- */

/** After sending, resolve a conversation/thread id from the messageId. */
async function resolveConversationId(token, accountId, messageId) {
  if (!messageId) return null;
  try {
    const detailUrl = `${MAIL_BASE}/api/accounts/${accountId}/messages/${messageId}`;
    const { data } = await axios.get(detailUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: 15000,
    });
    const m = data?.data;
    return m?.conversationId || m?.threadId || null;
  } catch (e) {
    console.error("Zoho message detail fetch failed:", e?.response?.data || e.message);
    return null;
  }
}

/** Fetch conversation messages; try both endpoints depending on DC. */
async function getConversationMessages(token, accountId, threadId) {
  // try conversations endpoint first
  try {
    const convUrl = `${MAIL_BASE}/api/accounts/${accountId}/conversations/${threadId}/messages?limit=50`;
    const { data } = await axios.get(convUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: 15000,
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (e1) {
    // fallback to older thread path
    try {
      const altUrl = `${MAIL_BASE}/api/accounts/${accountId}/messages/thread/${threadId}`;
      const { data } = await axios.get(altUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000,
      });
      return Array.isArray(data?.data) ? data.data : [];
    } catch (e2) {
      console.error("Zoho conversation fetch failed:", e2?.response?.data || e2.message);
      return [];
    }
  }
}

/** Broader fallback search by subject or free text. */
async function searchBySubjectPart(token, accountId, q) {
  const tries = [
    `subject:"${q}"`,
    `subject:${q}`,
    `${q}`,
    `"${q}"`,
  ];
  for (const key of tries) {
    try {
      const url = `${MAIL_BASE}/api/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(
        key
      )}&limit=200`;
      const { data } = await axios.get(url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000,
      });
      if (Array.isArray(data?.data) && data.data.length) return data.data;
    } catch {}
  }
  // last-resort: list and filter
  try {
    const listUrl = `${MAIL_BASE}/api/accounts/${accountId}/messages?limit=1000`;
    const { data: listData } = await axios.get(listUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      timeout: 20000,
    });
    const arr = Array.isArray(listData?.data) ? listData.data : [];
    return arr.filter((m) =>
      String(m?.subject || "").toLowerCase().includes(String(q).toLowerCase())
    );
  } catch {
    return [];
  }
}

/** Search messages that reference a specific message id (inReplyTo / references). */
async function searchByReferenceMessage(token, accountId, msgId) {
  if (!msgId) return [];
  const keys = [`inReplyTo:"${msgId}"`, `references:"${msgId}"`, `"${msgId}"`];
  for (const key of keys) {
    try {
      const url = `${MAIL_BASE}/api/accounts/${accountId}/messages/search?searchKey=${encodeURIComponent(
        key
      )}&limit=200`;
      const { data } = await axios.get(url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 15000,
      });
      if (Array.isArray(data?.data) && data.data.length) return data.data;
    } catch {}
  }
  return [];
}

/* ---------------- Single send (JSON) ---------------- */
router.post("/send-email", async (req, res) => {
  try {
    let { from, to, subject, content, cc, bcc, mailFormat, order_id } = req.body || {};
    if (!from || !to || !subject || !content) {
      return res.status(400).json({ message: "from, to, subject, content are required." });
    }

    const clean = (s) => (typeof s === "string" ? s.trim() : "");
    const joinList = (v) =>
      Array.isArray(v)
        ? v.filter(Boolean).map(clean).join(",")
        : clean(String(v || "").replace(/[;\n\r]+/g, ",").replace(/\s+/g, ""));

    const payload = {
      fromAddress: clean(from),
      toAddress: joinList(to),
      subject: clean(subject),
      content: String(content),
      askReceipt: "no",
      mailFormat: mailFormat === "plaintext" ? "plaintext" : "html",
    };
    if (cc) payload.ccAddress = joinList(cc);
    if (bcc) payload.bccAddress = joinList(bcc);

    const data = await withZohoToken(async (token) => {
      const accountId = await getAccountId(token);
      const url = `${MAIL_BASE}/api/accounts/${accountId}/messages`;
      const r = await axios.post(url, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });
      // resolve conversation/thread id using the returned message id
      const sentMeta = r?.data?.data || {};
      const messageId = sentMeta.messageId || sentMeta.id;
      const conversationId = await resolveConversationId(token, accountId, messageId);
      return { api: r.data, conversationId, messageId };
    });

    if (order_id) {
      await Order.updateOne(
        { order_id },
        {
          $inc: { email_count: 1 },
          ...(data.conversationId ? { threadId: String(data.conversationId) } : {}),
          ...(data.messageId ? { lastMessageId: String(data.messageId) } : {}),
        }
      ).exec();
    }

    res.json({ success: true, data: data.api });
  } catch (err) {
    console.error("Zoho Mail send error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      message: err?.response?.data?.message || err.message || "Zoho Mail send failed",
      details: err?.response?.data || null,
    });
  }
});

/* ---------------- Batch send with throttling + attachments ---------------- */
const upload = multer({ dest: "uploads/" });

async function sendOneEmail({ token, accountId, from, toAddress, subject, content, files }) {
  const url = `${MAIL_BASE}/api/accounts/${accountId}/messages`;
  if (files && files.length) {
    const fd = new FormData();
    fd.append("fromAddress", from);
    fd.append("toAddress", toAddress);
    fd.append("subject", subject);
    fd.append("content", content);
    fd.append("askReceipt", "no");
    fd.append("mailFormat", "html");
    files.forEach((f) => {
      fd.append("attachments", fs.createReadStream(f.path), { filename: f.originalname });
    });
    const r = await axios.post(url, fd, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, ...fd.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 30000,
    });
    return r.data;
  } else {
    const payload = {
      fromAddress: from,
      toAddress,
      subject,
      content,
      askReceipt: "no",
      mailFormat: "html",
    };
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    });
    return r.data;
  }
}

/**
 * POST /api/zoho/send-batch
 * Fields:
 *  - from: string
 *  - to: array of emails (JSON) or comma-separated string
 *  - subjectTemplateKey: "notDelivered" | "carrier"
 *  - contentTemplateKey: "statusNotDelivered" | "resolveQuery"
 *  - orders: JSON string or array [{order_id, carrier, tracking_number, shipment_status, order_date}]
 *  - gapSeconds?: number (default 60)
 *  - attachments?: files[] (optional)
 */
router.post("/send-batch", upload.array("attachments", 10), async (req, res) => {
  try {
    const hasFiles = (req.files || []).length > 0;
    const body = req.body || {};

    const from = (body.from || "").trim();
    const agentName =
      (body.agentName && String(body.agentName).trim()) ||
       (from ? String(from).split("@")[0].replace(/\./g, " ") : "Agent");
    let to;
    try {
      to = Array.isArray(body.to) ? body.to : JSON.parse(body.to || "[]");
    } catch {
      to = String(body.to || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const subjectTemplateKey = body.subjectTemplateKey || "notDelivered";
    const contentTemplateKey = body.contentTemplateKey || "statusNotDelivered";
    const gapSeconds = Number(body.gapSeconds || 60);

    let orders;
    try {
      orders = Array.isArray(body.orders) ? body.orders : JSON.parse(body.orders || "[]");
    } catch {
      orders = [];
    }

    if (!from || !to.length || !orders.length) {
      return res.status(400).json({
        message: "from, to (at least one), and orders (at least one) are required.",
      });
    }

    const subjectTpl = SUBJECT_TEMPLATES[subjectTemplateKey] || SUBJECT_TEMPLATES.notDelivered;
    const contentTpl = CONTENT_TEMPLATES[contentTemplateKey] || CONTENT_TEMPLATES.statusNotDelivered;
    const toAddress = to.join(",");

    await withZohoToken(async (token) => {
      const accountId = await getAccountId(token);

      orders.forEach((ord, idx) => {
        const vars = {
          order_id: ord.order_id || "",
          carrier: ord.carrier || "",
          tracking_number: ord.tracking_number || "",
          shipment_status: ord.shipment_status || "",
          order_date: ord.order_date ? new Date(ord.order_date).toISOString().slice(0,10) : "",
          agent_name: agentName,
        };

        const subject = render(subjectTpl, vars);
        const content = render(contentTpl, vars);

        setTimeout(async () => {
          try {
            const resp = await withZohoToken(async (t2) => {
              return await sendOneEmail({
                token: t2,
                accountId,
                from,
                toAddress,
                subject,
                content,
                files: hasFiles ? req.files : null,
              });
            });

            // Resolve conversation id from message id and save on the order
            const meta = resp?.data || {};
            const messageId = meta.messageId || meta.id;

            let conversationId = null;
            await withZohoToken(async (t3) => {
              const accId = await getAccountId(t3);
              conversationId = await resolveConversationId(t3, accId, messageId);
            });

            if (vars.order_id) {
              await Order.updateOne(
                { order_id: vars.order_id },
                {
                  $inc: { email_count: 1 },
                  ...(conversationId ? { threadId: String(conversationId) } : {}),
                  ...(messageId ? { lastMessageId: String(messageId) } : {}),
                }
              ).exec();
            }
          } catch (e) {
            console.error("Batch email failed:", e?.response?.data || e.message);
          } finally {
            if (hasFiles && idx === orders.length - 1) {
              setTimeout(() => cleanupUploads(req.files), 2000);
            }
          }
        }, idx * gapSeconds * 1000);
      });
    });

    res.json({ success: true, scheduled: orders.length, gapSeconds });
  } catch (err) {
    console.error("Zoho Mail batch error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      message: err?.response?.data?.message || err.message || "Zoho Mail batch failed",
      details: err?.response?.data || null,
    });
  }
});

/* ---------------- Replies & Sent list ---------------- */

// GET /api/zoho/sent?withReplies=1
router.get("/sent", async (req, res) => {
  try {
    const withReplies = String(req.query.withReplies || "0") === "1";

    const rows = await Order.find(
      { email_count: { $gt: 0 } },
      { _id: 0, order_id: 1, email_count: 1, threadId: 1, lastMessageId: 1 }
    )
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    const sentOrderIds = rows.map((r) => r.order_id);
    const counts = rows.reduce((acc, r) => {
      acc[r.order_id] = r.email_count || 0;
      return acc;
    }, {});

    if (!withReplies || sentOrderIds.length === 0) {
      return res.json({ sentOrderIds, counts });
    }

    const replies = await getRepliesForOrders(rows);
    return res.json({ sentOrderIds, counts, replies });
  } catch (err) {
    console.error("Zoho sent list error:", err?.response?.data || err.message);
    res.status(500).json({ message: "Failed to get sent list." });
  }
});

// Shared helper: given [{order_id, threadId, lastMessageId}], fetch latest non-self reply
async function getRepliesForOrders(orders) {
  const results = {};
  const RAW_SENDER = process.env.DEFAULT_FROM || "operations@muditam.com";
  const senderEmail = toEmail(RAW_SENDER);

  await withZohoToken(async (token) => {
    const accountId = await getAccountId(token);

    await Promise.all(
      orders.map(async (ord) => {
        const oid = ord.order_id;
        const threadId = ord.threadId;
        const lastMessageId = ord.lastMessageId;

        if (!oid) {
          results[oid] = null;
          return;
        }

        let messages = [];

        // 1) Try conversation endpoints
        if (threadId) {
          messages = await getConversationMessages(token, accountId, threadId);
        }

        // 2) If conversation empty, try by reference to our last sent message
        if (!messages?.length && lastMessageId) {
          const refHits = await searchByReferenceMessage(token, accountId, lastMessageId);
          if (refHits?.length) messages = refHits;
        }

        // 3) If still empty, try broader subject search
        if (!messages?.length) {
          const subjHits = await searchBySubjectPart(token, accountId, oid);
          if (subjHits?.length) messages = subjHits;
        }

        if (!messages?.length) { results[oid] = null; return; }

        // normalize & sort latest first
        messages.sort((a, b) =>
          new Date(b?.receivedTime || b?.date || 0) - new Date(a?.receivedTime || a?.date || 0)
        );

        // pick the first message not from ourselves; fallback to the latest anyway
        const notSelf = messages.find((m) => {
          const f = toEmail(m?.fromAddress || m?.from || "");
          return f && f !== senderEmail;
        });
        const chosen = notSelf || messages[0];

        const text =
          chosen?.summary ||
          stripHtml(chosen?.content || chosen?.snippet || chosen?.plainTextContent || "");

        results[oid] = {
          text: text || "(no preview)",
          at: chosen?.receivedTime || chosen?.date || null,
          from: chosen?.fromAddress || chosen?.from || "",
        };
      })
    );
  });

  return results;
}

// GET /api/zoho/replies?orderIds=a,b,c
router.get("/replies", async (req, res) => {
  try {
    const raw = String(req.query.orderIds || "").trim();
    if (!raw) return res.json({ replies: {} });
    const orderIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (orderIds.length === 0) return res.json({ replies: {} });

    const orders = await Order.find(
      { order_id: { $in: orderIds } },
      { order_id: 1, threadId: 1, lastMessageId: 1, _id: 0 }
    ).lean();

    const replies = await getRepliesForOrders(orders);
    res.json({ replies });
  } catch (err) {
    console.error("Zoho Mail replies error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      message: err?.response?.data?.message || err.message || "Zoho Mail replies failed",
      details: err?.response?.data || null,
    });
  }
});

/* ---------------- Reply in same thread ---------------- */
/**
 * POST /api/zoho/reply
 * body: { orderId: string, subjectTemplateKey: string, contentTemplateKey: string }
 * Uses Order.threadId or lastMessageId to reply in-thread.
 */ 

function normalizeList(csv = "") {
  return String(csv || "")
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function pickCounterpartyFromMessages(messages = [], ourEmail = "") {
  const ours = toEmail(ourEmail);
  // newest → oldest
  const sorted = [...messages].sort(
    (a, b) =>
      new Date(b?.receivedTime || b?.date || 0) -
      new Date(a?.receivedTime || a?.date || 0)
  );

  // try: the latest message not from us → its fromAddress
  for (const m of sorted) {
    const from = toEmail(m?.fromAddress || m?.from || "");
    if (from && from !== ours) return from;
  }

  // else: scan participants of latest few messages
  const candidates = new Map(); // email -> score
  for (const m of sorted.slice(0, 10)) {
    const from = toEmail(m?.fromAddress || m?.from || "");
    const tos = normalizeList(m?.toAddress || m?.to || "").map(toEmail);
    const ccs = normalizeList(m?.ccAddress || m?.cc || "").map(toEmail);
    [from, ...tos, ...ccs].forEach((addr) => {
      if (!addr || addr === ours) return;
      candidates.set(addr, (candidates.get(addr) || 0) + 1);
    });
  }

  // pick the most frequent counterparty
  let best = "";
  let bestScore = 0;
  for (const [addr, score] of candidates.entries()) {
    if (score > bestScore) {
      best = addr;
      bestScore = score;
    }
  }
  return best || "";
}

// ---------------- Reply in same thread (robust) ----------------
router.post("/reply", async (req, res) => {
  try {
    const { orderId, subjectTemplateKey, contentTemplateKey } = req.body || {};
    if (!orderId || !subjectTemplateKey || !contentTemplateKey) {
      return res.status(400).json({ message: "orderId, subjectTemplateKey, contentTemplateKey are required." });
    }

    const ord = await Order.findOne(
      { order_id: orderId },
      {
        order_id: 1,
        carrier: 1,
        carrier_title: 1,
        tracking_number: 1,
        shipment_status: 1,
        order_date: 1,
        threadId: 1,
        lastMessageId: 1, 
        lastExternalAddress: 1, // <-- optional convenience field
      }
    ).lean();
    if (!ord) return res.status(404).json({ message: "Order not found." });

    const vars = {
      order_id: ord.order_id || "",
      carrier: ord.carrier_title || ord.carrier || "",
      tracking_number: ord.tracking_number || "",
      shipment_status: ord.shipment_status || "",
      order_date: ord.order_date ? new Date(ord.order_date).toISOString().slice(0,10) : "",
      agent_name: derivedAgent,
    };
    const subjectTpl = SUBJECT_TEMPLATES[subjectTemplateKey] || SUBJECT_TEMPLATES.notDelivered;
    const contentTpl = CONTENT_TEMPLATES[contentTemplateKey] || CONTENT_TEMPLATES.statusNotDelivered;
    let subject = render(subjectTpl, vars);
    const content = render(contentTpl, vars);
    const FROM = process.env.DEFAULT_FROM || "operations@muditam.com";
    const AGENT_ENV = process.env.AGENT_NAME; // optional
    const derivedAgent = AGENT_ENV || (FROM ? String(FROM).split("@")[0].replace(/\./g, " ") : "Agent");

    const result = await withZohoToken(async (token) => {
      const accountId = await getAccountId(token);

      // Try to find a base message in this conversation
      let baseMessageId = ord.lastMessageId || null;

      if (!baseMessageId && ord.threadId) {
        const msgs = await getConversationMessages(token, accountId, ord.threadId);
        if (msgs?.length) {
          msgs.sort((a, b) =>
            new Date(b?.receivedTime || b?.date || 0) - new Date(a?.receivedTime || a?.date || 0)
          );
          baseMessageId = msgs[0]?.messageId || msgs[0]?.id || null;
        }
      }
      if (!baseMessageId) {
        const hits = await searchBySubjectPart(token, accountId, orderId);
        if (hits?.length) baseMessageId = hits[0]?.messageId || hits[0]?.id || null;
      }

      // First attempt: native reply endpoint (doesn't need toAddress)
      const tryNativeReply = async () => {
        if (!baseMessageId) return null;
        const replyUrl = `${MAIL_BASE}/api/accounts/${accountId}/messages/${baseMessageId}/reply`;
        try {
          const r = await axios.post(
            replyUrl,
            {
              fromAddress: FROM,
              subject,
              content,
              askReceipt: "no",
              mailFormat: "html",
            },
            { headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: 15000 }
          );
          const newMessageId = r?.data?.data?.messageId || r?.data?.data?.id || null;
          return { data: r.data, newMessageId, conversationId: ord.threadId || null };
        } catch (e) {
          const code = e?.response?.data?.errorCode;
          const http = e?.response?.status;
          if (http === 404 || code === "URL_RULE_NOT_CONFIGURED") return null; // fallback
          throw e;
        }
      };

      // Fallback: compose a normal message to the counterparty
      const fallbackCompose = async () => {
        // Gather messages to determine recipient
        let messages = [];
        if (ord.threadId) {
          messages = await getConversationMessages(token, accountId, ord.threadId);
        }
        // If we still have none, try fetching the base message detail
        if ((!messages || !messages.length) && baseMessageId) {
          try {
            const detailUrl = `${MAIL_BASE}/api/accounts/${accountId}/messages/${baseMessageId}`;
            const { data } = await axios.get(detailUrl, {
              headers: { Authorization: `Zoho-oauthtoken ${token}` },
              timeout: 15000,
            });
            const m = data?.data;
            if (m) messages = [m];
          } catch {}
        }

        const ourEmail = FROM;
        // priority 1: previously saved counterparty
        let toAddress = ord.lastExternalAddress || "";
        // priority 2: pick from messages
        if (!toAddress && messages?.length) {
          toAddress = pickCounterpartyFromMessages(messages, ourEmail);
        }

        if (!toAddress) {
          // Last resort: try the latest search hit
          if (!messages?.length) {
            const hits = await searchBySubjectPart(token, accountId, orderId);
            if (hits?.length) {
              toAddress = pickCounterpartyFromMessages(hits, ourEmail);
            }
          }
        }

        if (!toAddress) {
          // fail fast with clear message instead of 500 "Empty Recipients"
          throw Object.assign(new Error("Could not determine recipient for reply."), {
            response: { status: 400, data: { message: "No recipient found for this thread." } },
          });
        }

        // Ensure "Re:" subject
        if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;

        const url = `${MAIL_BASE}/api/accounts/${accountId}/messages`;
        const r = await axios.post(
          url,
          {
            fromAddress: FROM,
            toAddress,
            subject,
            content,
            askReceipt: "no",
            mailFormat: "html",
          },
          { headers: { Authorization: `Zoho-oauthtoken ${token}` }, timeout: 15000 }
        );
        const newMessageId = r?.data?.data?.messageId || r?.data?.data?.id || null;

        return {
          data: r.data,
          newMessageId,
          conversationId:
            (messages && messages[0] && (messages[0].conversationId || messages[0].threadId)) ||
            ord.threadId ||
            null,
          toAddress,
        };
      };

      const native = await tryNativeReply();
      if (native) return native;

      return await fallbackCompose();
    });

    // Persist ids + counterparty for next time
    const update = {};
    if (result?.newMessageId) update.lastMessageId = String(result.newMessageId);
    if (result?.conversationId) update.threadId = String(result.conversationId);
    if (result?.toAddress) update.lastExternalAddress = String(result.toAddress).toLowerCase();
    if (Object.keys(update).length) {
      await Order.updateOne({ order_id: orderId }, { $set: update }).exec();
    }

    res.json({ success: true, data: result?.data || null });
  } catch (err) {
    console.error("Zoho Mail reply error:", err?.response?.data || err.message);
    const status = err?.response?.status || 500;
    const body = err?.response?.data || { message: err.message || "Zoho Mail reply failed" };
    res.status(status).json({
      message: body?.message || err.message || "Zoho Mail reply failed",
      details: body || null,
    });
  }
});

// helper to robustly extract the sender email string
function extractFromAddress(m) {
  // try strings first
  const s =
    m?.fromAddress ||
    m?.from ||
    m?.sender ||
    (m?.senderDetails && (m.senderDetails.address || m.senderDetails.emailAddress)) ||
    "";
  if (typeof s === "string") return s;
  if (s && typeof s === "object") {
    return s.address || s.email || s.emailAddress || "";
  }
  return "";
}

/**
 * GET /api/zoho/replies/list?orderId=XXX&offset=0&limit=10
 * Returns messages newest->oldest (now includes all messages), with an isSelf flag.
 */
router.get("/replies/list", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "10", 10)));
    if (!orderId) return res.status(400).json({ message: "orderId required" });

    const RAW_SENDER = process.env.DEFAULT_FROM || "operations@muditam.com";
    const senderEmail = toEmail(RAW_SENDER);

    const ord = await Order.findOne(
      { order_id: orderId },
      { order_id: 1, threadId: 1, lastMessageId: 1, _id: 0 }
    ).lean();
    if (!ord) return res.status(404).json({ message: "Order not found" });

    let messages = [];
    await withZohoToken(async (token) => {
      const accountId = await getAccountId(token);

      if (ord.threadId) {
        messages = await getConversationMessages(token, accountId, ord.threadId);
      }
      if (!messages?.length && ord.lastMessageId) {
        const refHits = await searchByReferenceMessage(token, accountId, ord.lastMessageId);
        if (refHits?.length) messages = refHits;
      }
      if (!messages?.length) {
        const subjHits = await searchBySubjectPart(token, accountId, orderId);
        if (subjHits?.length) messages = subjHits;
      }
    });

    if (!messages?.length) {
      return res.json({ items: [], offset, limit, hasMore: false, total: 0 });
    }

    // Newest first
    messages.sort((a, b) =>
      new Date(b?.receivedTime || b?.date || 0) - new Date(a?.receivedTime || a?.date || 0)
    );

    // Map everything (don't filter yet)
    const mapped = messages.map((m) => {
      const fromRaw = extractFromAddress(m);
      const fromEmail = toEmail(fromRaw);
      const isSelf = !!fromEmail && fromEmail === senderEmail;
      const text =
        m?.summary ||
        stripHtml(m?.content || m?.snippet || m?.plainTextContent || "") ||
        "(no preview)";
      const at = m?.receivedTime || m?.date || null;
      return { from: fromRaw || "", fromEmail, isSelf, at, text };
    });

    // Paginate the full set (client will filter if needed)
    const total = mapped.length;
    const slice = mapped.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    res.json({ items: slice, offset, limit, hasMore, total });
  } catch (err) {
    console.error("Zoho list replies error:", err?.response?.data || err.message);
    res.status(err?.response?.status || 500).json({
      message: err?.response?.data?.message || err.message || "Zoho list replies failed",
      details: err?.response?.data || null,
    });
  }
});



/* ---------------- Optional diag ---------------- */
router.get("/diag", (req, res) => {
  res.json({
    dc: DC,
    hasClientId: !!process.env.CLIENT_ID,
    hasClientSecret: !!process.env.CLIENT_SECRET,
    hasRefreshToken: !!process.env.REFRESH_TOKEN,
    hasAccessTokenInMem: !!process.env.ZOHO_ACCESS_TOKEN,
    cachedAccountId: cachedAccountId || null,
  });
});

module.exports = router;
