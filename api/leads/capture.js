import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { json, supabaseAdmin } from "../_lib/server.js";

const MAX_BODY_BYTES = 16 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let limiter;

/** @typedef {{ email: string, businessName?: string|null, websiteUrl: string, phone?: string|null, businessType?: string|null, auditId: string, source?: string, landingPage?: string|null, marketingConsent?: boolean }} CaptureInput */
/** @typedef {{ success: true, leadId: string, checklist: { status: "queued"|"already_queued" }, message: string }} CaptureResponse */

function getLimiter() {
  if (limiter) return limiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("rate_limiter_not_configured");
  }
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, "10 m"),
    analytics: true,
    prefix: "sitelift:lead-capture"
  });
  return limiter;
}

/** Use Vercel's platform-provided client IP header, then socket fallback. */
function requestIp(req) {
  const realIp = req.headers?.["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim().slice(0, 100);
  return String(req.socket?.remoteAddress || "unknown").slice(0, 100);
}

/**
 * Strictly validate a URL that is only stored and correlated to an existing
 * audit. This handler never fetches the submitted URL. IP literals and local,
 * reserved, metadata, and non-standard-port hosts are rejected.
 * @param {unknown} value
 * @returns {URL|null}
 */
export function parsePublicWebsiteUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0 || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  if (/^[0-9.]+$/.test(host) || host.split(".").some(label =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) return null;
  if (parsed.port && !["80", "443"].includes(parsed.port)) return null;
  const blocked = host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") ||
    host.endsWith(".invalid") || host.endsWith(".example") ||
    host === "metadata" || host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") || host === "169.254.169.254";
  if (blocked) return null;
  // Canonicalize default ports, host case, and path; drop fragments because they
  // are not sent to servers and should not create distinct lead identities.
  parsed.hash = "";
  return parsed;
}

function normalizedEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) && !email.includes("..") ? email : null;
}

function optionalText(value, maxLength, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid_" + field);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error("invalid_" + field);
  }
  return normalized || null;
}

function safeLandingPage(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/") ||
      value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    throw new Error("invalid_landing_page");
  }
  return value;
}

function requestBody(req) {
  const contentLength = Number(req.headers?.["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return { tooLarge: true };
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { invalid: true };
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(body), "utf8"); } catch { return { invalid: true }; }
  if (bytes > MAX_BODY_BYTES) return { tooLarge: true };
  return { body };
}

function idempotencyKey(req, input) {
  const supplied = req.headers?.["idempotency-key"];
  if (supplied !== undefined && supplied !== null) {
    if (typeof supplied !== "string" || supplied.trim().length < 8 || supplied.length > 200) {
      throw new Error("invalid_idempotency_key");
    }
    return createHash("sha256").update("header:").update(supplied.trim()).digest("hex");
  }
  // Consent is deliberately excluded: replays cannot silently change consent.
  const stable = JSON.stringify({
    email: input.email,
    websiteUrl: input.websiteUrl,
    auditId: input.auditId,
    source: input.source,
    businessName: input.businessName,
    phone: input.phone,
    businessType: input.businessType,
    landingPage: input.landingPage
  });
  return createHash("sha256").update("body:").update(stable).digest("hex");
}

/**
 * @param {{ getSupabaseAdmin?: typeof supabaseAdmin, createRateLimiter?: () => { limit: (key: string) => Promise<{success: boolean, limit?: number, remaining?: number, reset?: number}> }, now?: () => Date }} [dependencies]
 */
export function createLeadCaptureHandler({
  getSupabaseAdmin = supabaseAdmin,
  createRateLimiter = getLimiter,
  now = () => new Date()
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const parsedBody = requestBody(req);
    if (parsedBody.tooLarge) return json(res, 413, { error: "Request body exceeds the 16 KB limit." });
    if (parsedBody.invalid) return json(res, 400, { error: "A JSON object is required." });

    const body = parsedBody.body;
    const email = normalizedEmail(body.email);
    const website = parsePublicWebsiteUrl(body.websiteUrl);
    const auditId = typeof body.auditId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.auditId)
      ? body.auditId.toLowerCase() : null;
    const marketingConsent = body.marketingConsent === undefined ? false : body.marketingConsent;
    if (!email) return json(res, 400, { error: "Enter a valid email address." });
    if (!website) return json(res, 400, { error: "Enter a valid public website URL using HTTP or HTTPS." });
    if (!auditId) return json(res, 400, { error: "A valid auditId is required." });
    if (typeof marketingConsent !== "boolean") return json(res, 400, { error: "marketingConsent must be true or false." });

    let businessName, phone, businessType, source, landingPage, key;
    try {
      businessName = optionalText(body.businessName, 160, "business_name");
      phone = optionalText(body.phone, 40, "phone");
      businessType = optionalText(body.businessType, 80, "business_type");
      source = optionalText(body.source, 80, "source") || "website_audit";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(source)) throw new Error("invalid_source");
      landingPage = safeLandingPage(body.landingPage);
      key = idempotencyKey(req, {
        email, websiteUrl: website.toString(), auditId, source,
        businessName, phone, businessType, landingPage
      });
    } catch (error) {
      const message = String(error?.message || "");
      const field = message.startsWith("invalid_") ? message.slice(8).replaceAll("_", " ") : "request";
      return json(res, 400, { error: "Invalid " + field + "." });
    }

    let rate;
    try {
      rate = await createRateLimiter().limit(requestIp(req));
    } catch {
      console.error("SiteLift lead capture rate limiter unavailable");
      return json(res, 503, { error: "Lead capture is temporarily unavailable. Please try again shortly." });
    }
    if (rate.limit !== undefined) res.setHeader("RateLimit-Limit", String(rate.limit));
    if (rate.remaining !== undefined) res.setHeader("RateLimit-Remaining", String(rate.remaining));
    if (!rate.success) {
      const retryAfter = rate.reset ? Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)) : 600;
      res.setHeader("Retry-After", String(retryAfter));
      return json(res, 429, { error: "Too many checklist requests. Please try again later." });
    }

    try {
      const db = getSupabaseAdmin();
      const { data: audit, error: auditError } = await db.from("audits")
        .select("id,target_url,final_url").eq("id", auditId).maybeSingle();
      if (auditError) throw new Error("audit_lookup_failed");
      if (!audit) return json(res, 404, { error: "The referenced audit was not found." });

      const auditHosts = [audit.target_url, audit.final_url].flatMap(value => {
        try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; }
      });
      if (!auditHosts.includes(website.hostname.toLowerCase())) {
        return json(res, 400, { error: "websiteUrl must match the website recorded for auditId." });
      }

      const consentRecordedAt = marketingConsent ? now().toISOString() : null;
      const { data, error } = await db.rpc("capture_sitelift_lead", {
        p_email: email,
        p_business_name: businessName,
        p_website_url: website.toString(),
        p_phone: phone,
        p_business_type: businessType,
        p_audit_id: auditId,
        p_source: source,
        p_landing_page: landingPage,
        p_marketing_consent: marketingConsent,
        p_consent_recorded_at: consentRecordedAt,
        p_idempotency_key: key
      });
      if (error) {
        if (/idempotency_conflict/i.test(String(error.message || ""))) {
          return json(res, 409, { error: "This Idempotency-Key was already used for a different submission." });
        }
        throw new Error("lead_persistence_failed");
      }
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.lead_id || !result?.delivery_job_id) throw new Error("lead_persistence_failed");
      return json(res, result.idempotent ? 200 : 201, {
        success: true,
        leadId: result.lead_id,
        checklist: { status: result.idempotent ? "already_queued" : "queued" },
        message: "Your checklist request has been received."
      });
    } catch (error) {
      // Do not log request content, addresses, tokens, credentials, or raw provider errors.
      console.error("SiteLift lead capture failed", error?.message === "audit_lookup_failed" ? "audit_lookup_failed" : "persistence_unavailable");
      return json(res, 503, { error: "Lead capture is temporarily unavailable. Please try again shortly." });
    }
  };
}

export const config = { maxDuration: 15 };
export default createLeadCaptureHandler();
