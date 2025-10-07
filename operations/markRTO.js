// ordersRouter.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const SHOP   = process.env.SHOPIFY_STORE_NAME;               
const TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;             
const APIVER = process.env.SHOPIFY_API_VERSION || '2025-07';  

// ------- uploads -------
const uploadDir = path.join(__dirname, 'uploads'); 
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename:    (_, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// ------- HTTP clients -------
const rest = axios.create({
  baseURL: `https://${SHOP}.myshopify.com/admin/api/${APIVER}`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
});

const gql = axios.create({
  baseURL: `https://${SHOP}.myshopify.com/admin/api/${APIVER}/graphql.json`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
});

// ------- helpers: file parsing -------
function parseCSV(fp) {
  const lines = fs.readFileSync(fp, 'utf-8').trim().split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const [nameCol, qtyCol] = line.split(',');
    const orderName = (nameCol || '').trim();
    if (!orderName) continue;
    const qty = Math.max(1, parseInt((qtyCol || '1').trim(), 10) || 1);
    out.push({ orderName, quantity: qty });
  }
  return out;
}
function parseExcel(fp) {
  const wb = XLSX.readFile(fp);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const out = [];
  for (const row of rows) {
    if (!row || !row.length) continue;
    const orderName = String(row[0] ?? '').trim();
    if (!orderName) continue;
    const qty = Math.max(1, parseInt(String(row[1] ?? '1').trim(), 10) || 1);
    out.push({ orderName, quantity: qty });
  }
  return out;
}

// ------- helpers: Shopify -------
async function getOrderByNameOnce(name) {
  const resp = await rest.get('/orders.json', { params: { name } });
  return resp.data?.orders?.[0] || null;
}

// NEW: get full order (not just id), trying with/without '#'
async function getOrderByNameFull(orderName) {
  let order = await getOrderByNameOnce(orderName);
  if (order) return order;

  if (orderName.startsWith('#')) {
    order = await getOrderByNameOnce(orderName.slice(1));
    if (order) return order;
  } else {
    order = await getOrderByNameOnce(`#${orderName}`);
    if (order) return order;
  }
  return null;
}

async function getOrderIdByName(orderName) {
  const order = await getOrderByNameFull(orderName);
  return order ? order.id : null;
}

const toOrderGID = (restId) => `gid://shopify/Order/${restId}`;

/** Returnable line items (pre-return stage) */
async function getReturnableLineItems(orderGID) {
  const query = `
    query ($orderId: ID!) {
      returnableFulfillments(orderId: $orderId, first: 20) {
        nodes {
          returnableFulfillmentLineItems(first: 250) {
            nodes {
              quantity
              fulfillmentLineItem { id }
            }
          }
        }
      }
    }
  `;
  const { data } = await gql.post('', { query, variables: { orderId: orderGID } });
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
  const nodes = data.data?.returnableFulfillments?.nodes ?? [];
  return nodes.flatMap(n =>
    (n.returnableFulfillmentLineItems?.nodes ?? []).map(li => ({
      fulfillmentLineItemId: li.fulfillmentLineItem.id,
      remainingQuantity: li.quantity || 0,
    }))
  );
}

async function returnCreate(orderGID, items, reason = 'OTHER', note = 'RTO via automation') {
  const mutation = `
    mutation ($input: ReturnInput!) {
      returnCreate(returnInput: $input) {
        userErrors { field message }
        return {
          id
          returnLineItems(first: 50) {
            edges {
              node {
                id
                quantity
                ... on ReturnLineItem {
                  fulfillmentLineItem { id }
                }
              }
            }
          }
        }
      }
    }
  `;
  const input = {
    orderId: orderGID,
    notifyCustomer: false,
    returnLineItems: items.map(it => ({
      fulfillmentLineItemId: it.fulfillmentLineItemId,
      quantity: it.quantity,
      returnReason: reason,
      returnReasonNote: note,
    })),
  };
  const { data } = await gql.post('', { query: mutation, variables: { input } });
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
  const payload = data.data.returnCreate;
  if (payload.userErrors?.length) throw new Error(payload.userErrors.map(u => u.message).join('; '));
  return payload.return;
}

/** Pull mapping & a location to restock into */
async function loadReturnForProcessing(returnId, orderGID) {
  const query = `
    query ($rid: ID!, $oid: ID!) {
      return(id: $rid) {
        id
        returnLineItems(first: 50) {
          edges {
            node {
              id
              quantity
              ... on ReturnLineItem {
                fulfillmentLineItem { id }
              }
            }
          }
        }
        reverseFulfillmentOrders(first: 10) {
          nodes {
            lineItems(first: 100) {
              nodes { id fulfillmentLineItem { id } totalQuantity }
            }
          }
        }
      }
      order(id: $oid) {
        fulfillmentOrders(first: 10) {
          nodes {
            assignedLocation { location { id } }
          }
        }
      }
    }
  `;
  const { data } = await gql.post('', { query, variables: { rid: returnId, oid: orderGID } });
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

async function returnProcessRestock(ret, mapping, locationId) {
  const mutation = `
    mutation ($input: ReturnProcessInput!) {
      returnProcess(input: $input) {
        userErrors { field message code }
        return { id status }
      }
    }
  `;

  const returnLineItems = mapping.map(m => ({
    id: m.returnLineItemId,
    quantity: m.quantity,
    dispositions: [{
      reverseFulfillmentOrderLineItemId: m.rfoLineItemId,
      dispositionType: 'RESTOCKED',
      quantity: m.quantity,
      locationId,
    }],
  }));

  const variables = {
    input: {
      returnId: ret.id,
      notifyCustomer: false,
      returnLineItems,
    },
  };

  const { data } = await gql.post('', { query: mutation, variables });
  if (data.errors?.length) throw new Error(data.errors.map(e => e.message).join('; '));
  const payload = data.data.returnProcess;
  if (payload.userErrors?.length) throw new Error(payload.userErrors.map(u => u.message).join('; '));
  return payload.return;
}

async function processOrderName(orderName, requestedQty = 1, opts = {}) {
  // Get full order so we can check financial_status
  const order = await getOrderByNameFull(orderName);
  if (!order) return { orderName, status: 'not_found', message: 'Order not found' };

  // Skip paid orders
  const fs = (order.financial_status || '').toLowerCase();
  if (fs === 'paid') {
    return {
      orderName,
      status: 'skipped_paid',
      message: 'Order financial status is Paid; skipped.',
    };
  }

  const restOrderId = order.id;
  const orderGID = toOrderGID(restOrderId);

  // 0) Eligible items to return
  const elig = await getReturnableLineItems(orderGID);
  if (!elig.length) return { orderName, status: 'no_returnables', message: 'No returnable items found' };

  const first = elig[0];
  const qty = Math.min(Math.max(1, requestedQty || 1), first.remainingQuantity || 0);
  if (!qty) return { orderName, status: 'zero_remaining', message: 'No remaining quantity to return' };

  // 1) create the return
  const created = await returnCreate(
    orderGID,
    [{ fulfillmentLineItemId: first.fulfillmentLineItemId, quantity: qty }],
    opts.returnReason || 'OTHER',
    opts.returnReasonNote || 'RTO via automation'
  );

  // 2) gather mapping + a restock location
  const data = await loadReturnForProcessing(created.id, orderGID);

  const rli = (data.return?.returnLineItems?.edges || []).map(e => e.node);
  const rfoLines = (data.return?.reverseFulfillmentOrders?.nodes || [])
    .flatMap(n => n.lineItems?.nodes || []);
  const foNodes = data.order?.fulfillmentOrders?.nodes || [];
  const locationId = foNodes[0]?.assignedLocation?.location?.id;

  if (!locationId) return { orderName, status: 'error', message: 'No location found to restock' };

  // Match by fulfillmentLineItem.id (requires inline fragments above)
  const mapping = [];
  for (const line of rli) {
    const fliId = line?.fulfillmentLineItem?.id;
    if (!fliId) continue;
    const match = rfoLines.find(n => n.fulfillmentLineItem?.id === fliId);
    if (match) {
      mapping.push({
        returnLineItemId: line.id,
        rfoLineItemId: match.id,
        quantity: Math.min(line.quantity, qty),
      });
    }
  }

  if (!mapping.length) return { orderName, status: 'error', message: 'Could not map return lines for disposition' };

  // 3) process + RESTOCK
  const processed = await returnProcessRestock(created, mapping, locationId);

  return { orderName, status: 'return_created', returnId: processed.id };
}

router.post('/orders/upload-orders', upload.single('file'), async (req, res) => {
  try {
    let jobs = [];
    if (req.file) {
      const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
      if (ext === 'csv') jobs = parseCSV(req.file.path);
      else if (ext === 'xlsx' || ext === 'xls') jobs = parseExcel(req.file.path);
      else return res.status(400).json({ success: false, message: 'Unsupported file type' });
    } else if (req.body.orderName) {
      const qty = Math.max(1, parseInt(String(req.body.quantity || '1'), 10) || 1);
      jobs = [{ orderName: String(req.body.orderName).trim(), quantity: qty }];
    }

    if (!jobs.length) return res.status(400).json({ success: false, message: 'No valid orders to process' });

    const results = [];
    for (const job of jobs) {
      try {
        const r = await processOrderName(job.orderName, job.quantity, {
          returnReason: req.body.returnReason || 'OTHER',
          returnReasonNote: req.body.returnReasonNote || 'RTO via automation',
        });
        results.push(r);
      } catch (e) {
        results.push({ orderName: job.orderName, status: 'error', message: e.message });
      }
    } 
    res.json({ success: true, message: 'Processed', results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});
 
/** JSON helper for a single manual order */
router.post('/orders/update-order', express.json(), async (req, res) => {
  try {
    const { orderName, quantity = 1, returnReason, returnReasonNote } = req.body || {};
    if (!orderName) return res.status(400).json({ success: false, message: 'orderName required' });
    const r = await processOrderName(orderName, quantity, { returnReason, returnReasonNote });
    if (r.status === 'return_created') return res.json({ success: true, result: r });
    return res.status(400).json({ success: false, result: r });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
