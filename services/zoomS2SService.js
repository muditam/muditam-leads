const axios = require("axios");

let cachedToken = "";
let tokenExpiresAt = 0;

function hasS2SConfig() {
  return Boolean(
    process.env.ZOOM_S2S_ACCOUNT_ID &&
      process.env.ZOOM_S2S_CLIENT_ID &&
      process.env.ZOOM_S2S_CLIENT_SECRET
  );
}

function basicAuthHeader() {
  const id = process.env.ZOOM_S2S_CLIENT_ID || "";
  const secret = process.env.ZOOM_S2S_CLIENT_SECRET || "";
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function getS2SAccessToken() {
  if (!hasS2SConfig()) {
    throw new Error("Missing Zoom S2S config. Set ZOOM_S2S_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET");
  }

  const now = Date.now();
  if (cachedToken && tokenExpiresAt - now > 120000) {
    return cachedToken;
  }

  const resp = await axios.post("https://zoom.us/oauth/token", null, {
    params: {
      grant_type: "account_credentials",
      account_id: process.env.ZOOM_S2S_ACCOUNT_ID,
    },
    headers: { Authorization: basicAuthHeader() },
    timeout: 20000,
  });

  const data = resp.data || {};
  cachedToken = String(data.access_token || "");
  tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  if (!cachedToken) throw new Error("Failed to obtain Zoom S2S token");
  return cachedToken;
}

async function zoomPhoneS2SGet(path, params = {}) {
  const token = await getS2SAccessToken();
  const resp = await axios.get(`https://api.zoom.us/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 30000,
  });
  return resp.data || {};
}

module.exports = {
  hasS2SConfig,
  getS2SAccessToken,
  zoomPhoneS2SGet,
};
