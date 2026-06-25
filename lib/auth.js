const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 días

function getSecret() {
  return process.env.SESSION_SECRET || "dev-secret-change-me";
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto
    .createHmac("sha256", getSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, mac] = parts;
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(data)
    .digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch (_e) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

function issueToken(payload = {}) {
  return sign({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
}

async function checkPassword(plain) {
  const hash = process.env.ADMIN_PASSWORD_HASH || "";
  if (!hash) return false;
  try {
    return await bcrypt.compare(String(plain || ""), hash);
  } catch (_e) {
    return false;
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: "No autorizado." });
  req.session = payload;
  return next();
}

module.exports = { issueToken, verify, checkPassword, requireAuth };
