const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const requireSession = require("../middleware/requireSession");
const ZoomToken = require("../models/ZoomToken");
const { encrypt } = require("../services/zoomCrypto");
const { basicAuthHeader, getUserIdFromReq, getValidAccessTokenForUser } = require("../services/zoomAuthService");

const router = express.Router();

const SCOPES = [
  "phone:read:user",
  "phone_call:read:user",
  "phone_call_recording:read",
  "phone_call_history:read:user",
].join(" ");

router.get("/authorize", requireSession, (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.zoomOAuthState = state;

  const redirectUri = process.env.ZOOM_REDIRECT_URI;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ZOOM_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
  });

  res.json({
    authorizeUrl: `https://zoom.us/oauth/authorize?${params.toString()}`,
  });
});

router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");
    if (!state || state !== req.session.zoomOAuthState) return res.status(400).send("Invalid state");

    const tokenResp = await axios.post("https://zoom.us/oauth/token", null, {
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.ZOOM_REDIRECT_URI,
      },
      headers: { Authorization: basicAuthHeader() },
      timeout: 20000,
    });

    const data = tokenResp.data || {};
    const accessToken = data.access_token || "";

    const meResp = await axios.get("https://api.zoom.us/v2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });

    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).send("Session missing");

    await ZoomToken.findOneAndUpdate(
      { userId },
      {
        userId,
        zoomUserId: String(meResp.data?.id || ""),
        zoomEmail: String(meResp.data?.email || ""),
        accessTokenEnc: encrypt(accessToken),
        refreshTokenEnc: encrypt(data.refresh_token || ""),
        tokenExpiresAt: new Date(Date.now() + Number(data.expires_in || 3600) * 1000),
        scopes: String(data.scope || "").split(" ").filter(Boolean),
      },
      { upsert: true, new: true }
    );

    res.redirect(`${process.env.APP_DOMAIN || "http://localhost:3000"}/calling-center?zoom_connected=true`);
  } catch (err) {
    console.error("Zoom callback error", err.response?.data || err.message);
    res.status(500).send("Zoom connection failed");
  }
});

router.post("/refresh", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    const token = await getValidAccessTokenForUser(userId);
    res.json({ ok: true, hasToken: Boolean(token) });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

router.get("/status", requireSession, async (req, res) => {
  const userId = getUserIdFromReq(req);
  const rec = await ZoomToken.findOne({ userId }).lean();
  res.json({
    connected: Boolean(rec),
    zoomEmail: rec?.zoomEmail || "",
    expiresAt: rec?.tokenExpiresAt || null,
  });
});

router.get("/debug", requireSession, async (req, res) => {
  try {
    const userId = getUserIdFromReq(req);
    const sessionUser = req.sessionUser || req.session?.user || null;
    const tokenRecord = await ZoomToken.findOne({ userId }).lean();

    const out = {
      now: new Date().toISOString(),
      session: {
        hasSessionUser: Boolean(sessionUser),
        userId: sessionUser?.id || sessionUser?._id || null,
        fullName: sessionUser?.fullName || sessionUser?.name || null,
        email: sessionUser?.email || null,
        role: sessionUser?.role || null,
      },
      token: {
        exists: Boolean(tokenRecord),
        zoomUserId: tokenRecord?.zoomUserId || null,
        zoomEmail: tokenRecord?.zoomEmail || null,
        tokenExpiresAt: tokenRecord?.tokenExpiresAt || null,
        expiresInSeconds: tokenRecord?.tokenExpiresAt
          ? Math.floor((new Date(tokenRecord.tokenExpiresAt).getTime() - Date.now()) / 1000)
          : null,
      },
      zoomMe: {
        ok: false,
        id: null,
        email: null,
        type: null,
        message: null,
      },
    };

    if (!tokenRecord) return res.json(out);

    try {
      const accessToken = await getValidAccessTokenForUser(userId);
      const meResp = await axios.get("https://api.zoom.us/v2/users/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20000,
      });
      out.zoomMe = {
        ok: true,
        id: meResp.data?.id || null,
        email: meResp.data?.email || null,
        type: meResp.data?.type ?? null,
        message: "Zoom token valid and users/me reachable",
      };
    } catch (err) {
      out.zoomMe = {
        ok: false,
        id: null,
        email: null,
        type: null,
        message: err.response?.data?.message || err.message || "users/me failed",
      };
    }

    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Debug failed" });
  }
});

router.delete("/disconnect", requireSession, async (req, res) => {
  const userId = getUserIdFromReq(req);
  await ZoomToken.deleteOne({ userId });
  res.json({ ok: true });
});

module.exports = router;
