import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./server.js";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** @typedef {{ id: string, lead_id: string, attempt_count: number, claim_token: string, status: string }} DeliveryJob */
/** @typedef {{ id: string, email: string, business_name: string|null, website_url: string, business_type: string|null }} Lead */

/** The checklist email is transactional; it is sent regardless of marketing consent. */
function checklistEmail(lead) {
  const name = lead.business_name ? lead.business_name : "there";
  const items = [
    "Check mobile loading speed and Core Web Vitals.",
    "Make the main service or product obvious above the fold.",
    "Verify that contact details and WhatsApp links work.",
    "Test forms, checkout, and key calls to action.",
    "Check navigation on a small screen.",
    "Use readable text, contrast, and accessible labels.",
    "Compress images and serve appropriately sized assets.",
    "Review page titles, meta descriptions, and canonical URLs.",
    "Check HTTPS, security headers, and dependency updates.",
    "Measure conversions and review results regularly."
  ];
  const list = items.map(item => "<li>" + escapeHtml(item) + "</li>").join("");
  const safeWebsite = escapeHtml(lead.website_url);
  const safeName = escapeHtml(name);
  const text = [
    "Hello " + name + ",",
    "",
    "Here is your SiteLift website review checklist:",
    ...items.map((item, index) => (index + 1) + ". " + item),
    "",
    "Website submitted: " + lead.website_url,
    "",
    "This is a transactional email for the checklist you requested. It does not subscribe you to marketing."
  ].join("\n");
  return {
    subject: "Your SiteLift website review checklist",
    text,
    html: "<!doctype html><html><body><h1>Your SiteLift website review checklist</h1><p>Hello " +
      safeName + ",</p><p>Use this checklist to review <a href=\"" + safeWebsite +
      "\">your website</a>:</p><ol>" + list + "</ol><p>This is a transactional email for the checklist you requested. It does not subscribe you to marketing.</p></body></html>"
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function retryDelay(attemptCount) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)));
}

function classifyFailure(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return { retryable: true, code: "resend_timeout" };
  if (error?.status === 429) return { retryable: true, code: "resend_rate_limited" };
  if ([408, 425].includes(error?.status)) return { retryable: true, code: "resend_transient_http_error" };
  if (typeof error?.status === "number" && error.status >= 500) return { retryable: true, code: "resend_server_error" };
  if (typeof error?.status === "number" && error.status >= 400) return { retryable: false, code: "resend_rejected" };
  return { retryable: true, code: "resend_network_error" };
}

/**
 * Process one job. SQL RPCs claim and finalize using a unique claim token, so a
 * stale worker cannot overwrite a newer worker's result.
 * @param {string|null} [jobId] Optionally restrict work to a particular job.
 * @param {{ getSupabaseAdmin?: typeof supabaseAdmin, fetchImpl?: typeof fetch, now?: () => Date }} [dependencies]
 * @returns {Promise<{status:"sent"|"retryable"|"failed"|"empty"|"lost_claim", jobId?:string}>}
 */
export async function processChecklistDeliveryJob(jobId = null, {
  getSupabaseAdmin = supabaseAdmin,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const db = getSupabaseAdmin();
  const { data: claimData, error: claimError } = await db.rpc("claim_sitelift_delivery_job", { p_job_id: jobId });
  if (claimError) {
    console.error("SiteLift delivery claim failed");
    throw new Error("delivery_claim_failed");
  }
  const job = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!job) return { status: "empty" };

  const finalize = async (status, nextAttemptAt, errorCode) => {
    const { data, error } = await db.rpc("finish_sitelift_delivery_job", {
      p_job_id: job.id,
      p_claim_token: job.claim_token,
      p_status: status,
      p_next_attempt_at: nextAttemptAt,
      p_error_code: errorCode
    });
    if (error) {
      console.error("SiteLift delivery finalization failed");
      throw new Error("delivery_finalize_failed");
    }
    if (data !== true) return { status: "lost_claim", jobId: job.id };
    return { status, jobId: job.id };
  };

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    const exhausted = Number(job.attempt_count) >= MAX_ATTEMPTS;
    const delay = retryDelay(Number(job.attempt_count));
    return finalize(exhausted ? "failed" : "retryable",
      exhausted ? null : new Date(now().getTime() + delay).toISOString(),
      "resend_not_configured");
  }

  const { data: lead, error: leadError } = await db.from("sitelift_leads")
    .select("id,email,business_name,website_url,business_type")
    .eq("id", job.lead_id).maybeSingle();
  if (leadError || !lead) {
    return finalize("failed", null, "lead_not_found");
  }

  let response;
  let failure = null;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": job.idempotency_key || randomUUID()
      },
      body: JSON.stringify({
        from,
        to: [lead.email],
        subject: checklistEmail(lead).subject,
        text: checklistEmail(lead).text,
        html: checklistEmail(lead).html
      }),
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) {
      const error = new Error("resend_http_error");
      error.status = response.status;
      failure = classifyFailure(error);
    }
  } catch (error) {
    failure = classifyFailure(error);
  }

  if (!failure) return finalize("sent", null, null);
  const exhausted = Number(job.attempt_count) >= MAX_ATTEMPTS;
  const status = failure.retryable && !exhausted ? "retryable" : "failed";
  const nextAttemptAt = status === "retryable"
    ? new Date(now().getTime() + retryDelay(Number(job.attempt_count))).toISOString()
    : null;
  // Persist only a fixed internal error code, never response bodies or credentials.
  return finalize(status, nextAttemptAt, failure.code);
}

/**
 * Drain a bounded number of jobs. Call from an authenticated scheduler/worker;
 * this module intentionally does not expose a public unauthenticated endpoint.
 * @param {{ limit?: number, getSupabaseAdmin?: typeof supabaseAdmin, fetchImpl?: typeof fetch, now?: () => Date }} [options]
 */
export async function processPendingChecklistDeliveries({
  limit = 10,
  getSupabaseAdmin = supabaseAdmin,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  const safeLimit = Math.max(1, Math.min(25, Math.floor(Number(limit) || 10)));
  const results = [];
  for (let index = 0; index < safeLimit; index += 1) {
    const result = await processChecklistDeliveryJob(null, { getSupabaseAdmin, fetchImpl, now });
    if (result.status === "empty") break;
    results.push(result);
  }
  return results;
}
