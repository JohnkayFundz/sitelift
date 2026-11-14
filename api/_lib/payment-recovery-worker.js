import { createAuditPdf, supabaseAdmin } from "./server.js";

const PAYSTACK_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JOBS = 1;
const DEFAULT_BUDGET_MS = 45_000;

class RecoveryError extends Error {
  constructor(code, retryable) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function verifyPaystackTransaction(reference, secret, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(
      "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
      {
        headers: { Authorization: "Bearer " + secret },
        signal: AbortSignal.timeout(PAYSTACK_VERIFY_TIMEOUT_MS)
      }
    );
  } catch {
    throw new RecoveryError("provider_unavailable", true);
  }

  if (!response.ok) {
    throw new RecoveryError(
      response.status >= 500 || response.status === 429
        ? "provider_unavailable"
        : "provider_verification_rejected",
      response.status >= 500 || response.status === 429
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new RecoveryError("provider_invalid_response", true);
  }

  if (!payload?.status || !payload.data) {
    throw new RecoveryError("provider_invalid_response", true);
  }
  return payload.data;
}

export async function processClaimedPaymentRecovery({
  claim,
  db,
  secret = process.env.PAYSTACK_SECRET_KEY,
  fetchImpl = fetch,
  generatePdf = createAuditPdf
}) {
  const reference = claim.reference;
  const leaseToken = claim.lease_token;

  const fail = async (error) => {
    const code = /^[a-z0-9_]{1,64}$/.test(error?.code || "")
      ? error.code
      : "internal_processing_error";
    const retryable = error instanceof RecoveryError ? error.retryable : true;
    const { data, error: rpcError } = await db.rpc("fail_payment_recovery_job", {
      p_reference: reference,
      p_lease_token: leaseToken,
      p_error_code: code,
      p_retryable: retryable
    });
    if (rpcError) {
      console.error("Payment recovery failure transition failed", rpcError.message);
      return { status: "failure_transition_error" };
    }
    return { status: data || "failure_transition_unknown", errorCode: code };
  };

  try {
    if (!secret) throw new RecoveryError("provider_not_configured", true);

    const transaction = await verifyPaystackTransaction(reference, secret, fetchImpl);

    if (transaction.status !== "success") {
      throw new RecoveryError("provider_transaction_not_successful", true);
    }
    if (
      transaction.reference !== reference ||
      transaction.currency !== "NGN" ||
      claim.currency !== "NGN" ||
      !Number.isSafeInteger(Number(transaction.amount)) ||
      Number(transaction.amount) !== Number(claim.amount) ||
      !Number.isSafeInteger(Number(transaction.id)) ||
      Number(transaction.id) <= 0
    ) {
      throw new RecoveryError("provider_transaction_mismatch", false);
    }

    const { data: owned, error: ownershipError } = await db.rpc(
      "assert_payment_recovery_lease",
      { p_reference: reference, p_lease_token: leaseToken }
    );
    if (ownershipError) throw new RecoveryError("lease_assertion_failed", true);
    if (owned !== true) return { status: "lease_lost" };

    const { data: audit, error: auditError } = await db.from("audits")
      .select("id,target_url,final_url,strategy,report,created_at")
      .eq("id", claim.audit_id)
      .maybeSingle();
    if (auditError) throw new RecoveryError("audit_lookup_failed", true);
    if (!audit) throw new RecoveryError("audit_missing", false);

    let pdf;
    try {
      pdf = generatePdf(audit);
      if (!Buffer.isBuffer(pdf) || pdf.length < 8 || pdf.subarray(0, 5).toString() !== "%PDF-") {
        throw new Error("Invalid PDF output");
      }
    } catch {
      throw new RecoveryError("pdf_generation_failed", false);
    }

    const { data: stillOwned, error: secondOwnershipError } = await db.rpc(
      "assert_payment_recovery_lease",
      { p_reference: reference, p_lease_token: leaseToken }
    );
    if (secondOwnershipError) throw new RecoveryError("lease_assertion_failed", true);
    if (stillOwned !== true) return { status: "lease_lost" };

    const pdfPath = claim.audit_id + "/" + reference + ".pdf";
    const { error: uploadError } = await db.storage.from("audit-reports")
      .upload(pdfPath, pdf, {
        contentType: "application/pdf",
        upsert: false,
        cacheControl: "3600"
      });
    if (uploadError && !/already exists|duplicate/i.test(String(uploadError.message || ""))) {
      throw new RecoveryError("pdf_upload_failed", true);
    }

    const { data: completed, error: completionError } = await db.rpc(
      "complete_payment_recovery_job",
      {
        p_reference: reference,
        p_lease_token: leaseToken,
        p_transaction_id: String(transaction.id),
        p_pdf_path: pdfPath
      }
    );
    if (completionError) throw new RecoveryError("completion_rpc_failed", true);
    if (completed !== true) return { status: "lease_lost" };
    return { status: "completed" };
  } catch (error) {
    return fail(error);
  }
}

export async function runPaymentRecoveryBatch({
  getSupabaseAdmin = supabaseAdmin,
  fetchImpl = fetch,
  generatePdf = createAuditPdf,
  maxJobs = DEFAULT_MAX_JOBS,
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => Date.now()
} = {}) {
  const startedAt = now();
  const db = getSupabaseAdmin();
  const results = [];

  while (results.length < maxJobs && now() - startedAt < budgetMs) {
    const { data, error } = await db.rpc("claim_payment_recovery_job");
    if (error) throw error;
    const claim = rpcRow(data);
    if (!claim) break;

    const result = await processClaimedPaymentRecovery({
      claim,
      db,
      fetchImpl,
      generatePdf
    });
    results.push(result);

    // Each lease is 120 seconds. Leave sufficient invocation headroom so a
    // second claim is not started near the serverless execution deadline.
    if (budgetMs - (now() - startedAt) < 20_000) break;
  }

  return {
    claimed: results.length,
    completed: results.filter((item) => item.status === "completed").length,
    retried: results.filter((item) => item.status === "retry_scheduled").length,
    deadLettered: results.filter((item) => item.status === "dead_letter").length,
    leaseLost: results.filter((item) => item.status === "lease_lost").length,
    failures: results.filter((item) =>
      !["completed", "retry_scheduled", "dead_letter", "lease_lost"].includes(item.status)
    ).length
  };
}
