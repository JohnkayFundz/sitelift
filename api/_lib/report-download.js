import { createHash } from "node:crypto";

export const REDEMPTION_COOKIE = "__Secure-sitelift-redemption";
export const REDEMPTION_TTL_SECONDS = 24 * 60 * 60;

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function readCookie(req, name) {
  const raw = req.headers?.cookie || "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return ""; }
  }
  return "";
}

function appendSetCookie(res, value) {
  const current = res.getHeader?.("Set-Cookie");
  const next = current ? (Array.isArray(current) ? [...current, value] : [current, value]) : value;
  res.setHeader("Set-Cookie", next);
}

export function setRedemptionCookie(res, reference, token, maxAge = REDEMPTION_TTL_SECONDS) {
  const value = encodeURIComponent(reference + "." + token);
  appendSetCookie(res, REDEMPTION_COOKIE + "=" + value +
    "; Path=/api/paystack; Max-Age=" + maxAge +
    "; HttpOnly; Secure; SameSite=Lax");
}

export function clearRedemptionCookie(res) {
  appendSetCookie(res, REDEMPTION_COOKIE +
    "=; Path=/api/paystack; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
}

export function readRedemptionCookie(req, reference) {
  const value = readCookie(req, REDEMPTION_COOKIE);
  const separator = value.lastIndexOf(".");
  if (separator < 0) return "";
  if (value.slice(0, separator) !== reference) return "";
  const token = value.slice(separator + 1);
  return /^[a-f0-9]{64}$/i.test(token) ? token : "";
}

export function reportSessionCookieName(auditId) {
  return "__Secure-sitelift-session-" + auditId;
}

export function setReportSessionCookie(res, auditId, token, maxAge = 3600) {
  appendSetCookie(res, reportSessionCookieName(auditId) + "=" + encodeURIComponent(token) +
    "; Path=/api/reports/" + auditId + "; Max-Age=" + maxAge +
    "; HttpOnly; Secure; SameSite=Strict");
}

export function clearReportSessionCookie(res, auditId) {
  appendSetCookie(res, reportSessionCookieName(auditId) +
    "=; Path=/api/reports/" + auditId + "; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
}
