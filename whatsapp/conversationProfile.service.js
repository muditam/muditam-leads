const mongoose = require("mongoose");

function digitsOnly(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function last10(v = "") {
  return digitsOnly(v).slice(-10);
}

function normalizeText(v = "") {
  return String(v || "").trim().toLowerCase();
}

function getModels() {
  return {
    Lead: mongoose.model("Lead"),
    Customer: mongoose.model("Customer"),
    WhatsAppConversation: mongoose.model("WhatsAppConversation"),
  };
}

async function resolveConversationProfilesByPhone10s(phones10 = []) {
  const normalized = Array.from(
    new Set((phones10 || []).map((value) => last10(value)).filter(Boolean))
  );
  if (!normalized.length) return new Map();

  const { Lead, Customer } = getModels();
  const [leads, customers] = await Promise.all([
    Lead.find({ contactNumber: { $in: normalized } })
      .select("contactNumber name healthExpertAssigned agentAssigned")
      .lean(),
    Customer.find({ phone: { $in: normalized } })
      .select("phone name assignedTo")
      .lean(),
  ]);

  const leadMap = new Map();
  for (const lead of leads || []) {
    const key = last10(lead?.contactNumber);
    if (key && !leadMap.has(key)) leadMap.set(key, lead);
  }

  const customerMap = new Map();
  for (const customer of customers || []) {
    const key = last10(customer?.phone);
    if (key && !customerMap.has(key)) customerMap.set(key, customer);
  }

  const profiles = new Map();
  for (const phone10 of normalized) {
    const lead = leadMap.get(phone10) || null;
    const customer = customerMap.get(phone10) || null;

    let displayName = phone10;
    let assignedToLabel = "Unassigned";

    if (lead) {
      displayName = String(lead?.name || "").trim() || phone10;
      assignedToLabel =
        String(lead?.healthExpertAssigned || "").trim() ||
        String(lead?.agentAssigned || "").trim() ||
        "Unassigned";
    } else if (customer) {
      displayName = String(customer?.name || "").trim() || phone10;
      assignedToLabel = String(customer?.assignedTo || "").trim() || "Unassigned";
    }

    profiles.set(phone10, {
      phone10,
      displayName,
      assignedToLabel,
    });
  }

  return profiles;
}

function buildConversationSearchText({
  phone = "",
  phone10 = "",
  displayName = "",
  assignedToLabel = "",
  lastMessageText = "",
} = {}) {
  return [
    phone,
    phone10,
    displayName,
    assignedToLabel,
    lastMessageText,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");
}

function buildConversationDerivedFields({
  phone = "",
  phone10 = "",
  displayName = "",
  assignedToLabel = "",
  lastMessageText = "",
} = {}) {
  const normalizedPhone10 = last10(phone10 || phone);
  const resolvedDisplayName = String(displayName || normalizedPhone10).trim() || normalizedPhone10;
  const resolvedAssignedToLabel =
    String(assignedToLabel || "Unassigned").trim() || "Unassigned";

  return {
    phone: String(phone || "").trim(),
    phone10: normalizedPhone10,
    displayName: resolvedDisplayName,
    displayNameNorm: normalizeText(resolvedDisplayName),
    assignedToLabel: resolvedAssignedToLabel,
    assignedToLabelNorm: normalizeText(resolvedAssignedToLabel),
    searchText: buildConversationSearchText({
      phone,
      phone10: normalizedPhone10,
      displayName: resolvedDisplayName,
      assignedToLabel: resolvedAssignedToLabel,
      lastMessageText,
    }),
  };
}

async function getConversationDerivedFields({ phone = "", lastMessageText = "" } = {}) {
  const normalizedPhone = String(phone || "").trim();
  const phone10 = last10(normalizedPhone);
  const profiles = await resolveConversationProfilesByPhone10s([phone10]);
  const profile = profiles.get(phone10) || null;

  return buildConversationDerivedFields({
    phone: normalizedPhone,
    phone10,
    displayName: profile?.displayName || phone10,
    assignedToLabel: profile?.assignedToLabel || "Unassigned",
    lastMessageText,
  });
}

async function syncConversationByPhone(phone = "", options = {}) {
  const normalizedPhone = String(phone || "").trim();
  const phone10 = last10(normalizedPhone);
  if (!phone10) return null;

  const { WhatsAppConversation } = getModels();
  const existing = await WhatsAppConversation.find({
    $or: [{ phone10 }, { phone: new RegExp(`${phone10}$`) }],
  })
    .select("_id phone lastMessageText manualAssignedToLabel manualAssignedToLabelNorm")
    .lean();

  if (!existing.length) {
    return getConversationDerivedFields({
      phone: normalizedPhone,
      lastMessageText: options?.lastMessageText || "",
    });
  }

  const ops = [];
  let lastDerivedFields = null;
  for (const convo of existing) {
    let derivedFields = await getConversationDerivedFields({
      phone: convo?.phone || normalizedPhone,
      lastMessageText: convo?.lastMessageText || options?.lastMessageText || "",
    });
    const manualAssignedToLabel = String(convo?.manualAssignedToLabel || "").trim();
    const manualAssignedToLabelNorm = normalizeText(
      convo?.manualAssignedToLabelNorm || manualAssignedToLabel
    );
    if (
      manualAssignedToLabel &&
      manualAssignedToLabelNorm &&
      normalizeText(derivedFields.assignedToLabel) === "unassigned"
    ) {
      derivedFields = {
        ...derivedFields,
        assignedToLabel: manualAssignedToLabel,
        assignedToLabelNorm: manualAssignedToLabelNorm,
        searchText: buildConversationSearchText({
          phone: convo?.phone || normalizedPhone,
          phone10: derivedFields.phone10,
          displayName: derivedFields.displayName,
          assignedToLabel: manualAssignedToLabel,
          lastMessageText: convo?.lastMessageText || options?.lastMessageText || "",
        }),
      };
    }
    lastDerivedFields = derivedFields;
    ops.push({
      updateOne: {
        filter: { _id: convo._id },
        update: { $set: derivedFields },
      },
    });
  }

  if (ops.length) {
    await WhatsAppConversation.bulkWrite(ops, { ordered: false });
  }

  return lastDerivedFields;
}

async function backfillConversationDerivedFields({
  batchSize = 200,
  maxBatches = Infinity,
  logger = console,
} = {}) {
  const { WhatsAppConversation } = getModels();
  let processed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const docs = await WhatsAppConversation.find(
      {
        $or: [
          { phone10: { $exists: false } },
          { phone10: "" },
          { displayName: { $exists: false } },
          { assignedToLabelNorm: { $exists: false } },
          { searchText: { $exists: false } },
        ],
      }
    )
      .select("_id phone lastMessageText")
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (!docs.length) break;

    const profiles = await resolveConversationProfilesByPhone10s(
      docs.map((doc) => last10(doc?.phone))
    );

    const ops = docs.map((doc) => {
      const phone = String(doc?.phone || "").trim();
      const phone10 = last10(phone);
      const profile = profiles.get(phone10) || null;
      const derivedFields = buildConversationDerivedFields({
        phone,
        phone10,
        displayName: profile?.displayName || phone10,
        assignedToLabel: profile?.assignedToLabel || "Unassigned",
        lastMessageText: doc?.lastMessageText || "",
      });

      return {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: derivedFields },
        },
      };
    });

    if (ops.length) {
      await WhatsAppConversation.bulkWrite(ops, { ordered: false });
      processed += ops.length;
    }
  }

  if (processed > 0) {
    logger.info?.(`WhatsApp conversation derived field backfill updated ${processed} records`);
  }

  return processed;
}

module.exports = {
  last10,
  normalizeText,
  buildConversationSearchText,
  buildConversationDerivedFields,
  resolveConversationProfilesByPhone10s,
  getConversationDerivedFields,
  syncConversationByPhone,
  backfillConversationDerivedFields,
};
