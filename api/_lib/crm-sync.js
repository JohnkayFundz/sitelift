import { supabaseAdmin } from "./server.js";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const CRM_DESTINATION = "johnkay_client_engine";

/**
 * CRM ingress isolation is intentional: no outbox job may be claimed or sent
 * unless CRM_SYNC_ENABLED is explicitly set to the exact string "true".
 *
 * BizBoard has no verified SiteLift ingress endpoint. A future receiver must
 * provide a dedicated server-to-server Bearer credential (not a Supabase user
 * access token), map lead.businessName -> company, and apply status "New Lead"
 * when no explicitly agreed status is supplied. It must persist the
 * Idempotency-Key atomically with lead creation and return the same durable
 * result for a replay of that key.
 *
 * Consent is independent of operational CRM synchronization. Never infer
 * marketing permission from lead creation or delivery. The current outbound
 * payload deliberately does not transmit consent; a future versioned contract
 * must preserve marketingConsent and consentRecordedAt explicitly, default
 * missing consent to false, and retain the timestamp only for an affirmative
 * recorded choice. Keep this worker disabled until that receiver contract,
 * authentication, field mapping, idempotency, and consent behavior are tested.
 */
function crmSyncEnabled() {
  return process.env.CRM_SYNC_ENABLED === "true";
}

/** @param {number} attemptCount */
function retryDelay(attemptCount) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)));
}

function classifyFailure(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return { retryable: true, code: "crm_timeout" };
  }
  if (error?.status === 429) return { retryable: true, code: "crm_rate_limited" };
  if ([408, 425].includes(error?.status)) return { retryable: true, code: "crm_transient_http_error" };
  if (typeof error?.status === "number" && error.status >= 500) {
    return { retryable: true, code: "crm_server_error" };
  }
  if (typeof error?.status === "number" && error.status >= 400) {
    return { retryable: false, code: "crm_rejected" };
  }
  return { retryable: true, code: "crm_network_error" };
}

function validCrmUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function buildCrmPayload(lead, outboxId) {
  return {
    source: "sitelift",
    idempotencyKey: outboxId,
    lead: {
      email: lead.email,
      businessName: lead.business_name ?? null,
      websiteUrl: lead.website_url,
      businessType: lead.business_type ?? null
    },
    audit: { id: lead.audit_id },
    acquisitionSource: lead.source
  };
}

/**
 * Process a claimed CRM outbox row. Database RPCs enforce atomic claims and
 * claim-token-fenced finalization; this helper never logs provider response data.
 * @param {string|null} [outboxId]
 * @param {{ getSupabaseAdmin?: typeof supabaseAdmin, fetchImpl?: typeof fetch, now?: () => Date }} [dependencies]
 */
export async function processCrmSyncJob(outboxId = null, {
  getSupabaseAdmin = supabaseAdmin,
  fetchImpl = fetch,
  now = () => new Date()
} = {}) {
  // Check before environment validation, database access, or any network work.
  if (!crmSyncEnabled()) return { status: "disabled" };

  const endpoint = process.env.CRM_API_URL;
  const apiKey = process.env.CRM_API_KEY;
  if (!endpoint || !apiKey || !validCrmUrl(endpoint)) {
    throw new Error("crm_sync_not_configured");
  }

  const db = getSupabaseAdmin();
  const { data: claimData, error: claimError } = await db.rpc("claim_sitelift_crm_sync", {
    p_job_id: outboxId
  });
  if (claimError) {
    console.error("SiteLift CRM sync claim failed");
    throw new Error("crm_sync_claim_failed");
  }
  const job = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!job) return { status: "empty" };

  const finalize = async (status, nextAttemptAt, errorCode, externalRecordId = null) => {
    const { data, error } = await db.rpc("finish_sitelift_crm_sync", {
      p_job_id: job.id,
      p_claim_token: job.claim_token,
      p_status: status,
      p_next_attempt_at: nextAttemptAt,
      p_error_code: errorCode,
      p_external_record_id: externalRecordId
    });
    if (error) {
      console.error("SiteLift CRM sync finalization failed");
      throw new Error("crm_sync_finalize_failed");
    }
    if (data !== true) return { status: "lost_claim", jobId: job.id };
    return { status, jobId: job.id };
  };

  const { data: lead, error: leadError } = await db.from("sitelift_leads")
    .select("id,email,business_name,website_url,business_type,audit_id,source")
    .eq("id", job.lead_id)
    .maybeSingle();

  if (leadError) {
    const exhausted = Number(job.attempt_count) >= MAX_ATTEMPTS;
    const nextAttemptAt = exhausted
      ? null
      : new Date(now().getTime() + retryDelay(Number(job.attempt_count))).toISOString();
    return finalize(exhausted ? "failed" : "retryable", nextAttemptAt, "crm_lead_lookup_failed");
  }
  if (!lead) return finalize("failed", null, "crm_lead_not_found");

  let failure = null;
  let externalRecordId = null;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": job.id
      },
      body: JSON.stringify(buildCrmPayload(lead, job.id)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const error = new Error("crm_http_error");
      error.status = response.status;
      failure = classifyFailure(error);
    } else {
      // Parse only a known identifier field. Never persist or log the raw body.
      const result = await response.json().catch(() => ({}));
      const candidate = result?.externalRecordId ?? result?.recordId ?? result?.id;
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 200) {
        externalRecordId = candidate;
      }
    }
  } catch (error) {
    failure = classifyFailure(error);
  }

  if (!failure) return finalize("synced", null, null, externalRecordId);

  const exhausted = Number(job.attempt_count) >= MAX_ATTEMPTS;
  const status = failure.retryable && !exhausted ? "retryable" : "failed";
  const nextAttemptAt = status === "retryable"
    ? new Date(now().getTime() + retryDelay(Number(job.attempt_count))).toISOString()
    : null;
  // Only fixed internal codes are persisted; never include response bodies or credentials.
  return finalize(status, nextAttemptAt, failure.code);
}

/** Process a bounded batch of due outbox rows. */
export async function processPendingCrmSync({ limit = 3, getSupabaseAdmin = supabaseAdmin, fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!crmSyncEnabled()) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.floor(Number(limit) || 3)));
  const results = [];
  for (let index = 0; index < safeLimit; index += 1) {
    const result = await processCrmSyncJob(null, { getSupabaseAdmin, fetchImpl, now });
    if (result.status === "empty") break;
    results.push(result);
  }
  return results;
}

export const crmSyncConstants = { MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, CRM_DESTINATION };
