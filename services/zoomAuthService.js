const axios = require("axios");
const ZoomToken = require("../models/ZoomToken");
const { decrypt, encrypt } = require("./zoomCrypto");

function getUserIdFromReq(req) {
  return req?.sessionUser?.id || req?.sessionUser?._id || req?.session?.user?.id || req?.session?.user?._id || null;
}

function basicAuthHeader() {
  const id = process.env.ZOOM_CLIENT_ID || "";
  const secret = process.env.ZOOM_CLIENT_SECRET || "";
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function refreshTokenRecord(tokenRecord) {
  const refreshToken = decrypt(tokenRecord.refreshTokenEnc);
  const resp = await axios.post("https://zoom.us/oauth/token", null, {
    params: { grant_type: "refresh_token", refresh_token: refreshToken },
    headers: { Authorization: basicAuthHeader() },
    timeout: 20000,
  });

  const data = resp.data || {};
  tokenRecord.accessTokenEnc = encrypt(data.access_token || "");
  if (data.refresh_token) tokenRecord.refreshTokenEnc = encrypt(data.refresh_token);
  tokenRecord.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in || 3600) * 1000);
  await tokenRecord.save();

  return decrypt(tokenRecord.accessTokenEnc);
}

async function getValidAccessTokenForUser(userId) {
  const record = await ZoomToken.findOne({ userId });
  if (!record) throw new Error("Zoom account is not connected for this user.");

  const nowPlus2m = Date.now() + 2 * 60 * 1000;
  if (!record.tokenExpiresAt || record.tokenExpiresAt.getTime() <= nowPlus2m) {
    return refreshTokenRecord(record);
  }
  return decrypt(record.accessTokenEnc);
}

module.exports = { getUserIdFromReq, getValidAccessTokenForUser, basicAuthHeader };
