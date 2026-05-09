const crypto = require("crypto");

function getKey() {
  const raw = String(process.env.ZOOM_TOKEN_ENC_KEY || process.env.SESSION_SECRET || "zoom-fallback-key");
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text || ""), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload) {
  if (!payload || !String(payload).includes(":")) return "";
  const [ivHex, encHex] = String(payload).split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getKey(), iv);
  const dec = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return dec.toString("utf8");
}

module.exports = { encrypt, decrypt };
