import { createHash } from "node:crypto";
import { createAuditPdf, supabaseAdmin } from "./server.js";

const PAYSTACK_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JOBS = 1;
const DEFAULT_BUDGET_MS = 45_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

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

function artifactIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > MAX_PDF_BYTES ||
    bytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new RecoveryError("pdf_integrity_invalid", false);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length
  };
}

function storageObjectMissing(error) {
  const status = String(error?.statusCode || error?.status || "");
  const message = String(error?.message || "");
  return status === "404" || /not found|object not found/i.test(message);
}

async function downloadAndVerifyObject(storage, path, expected) {
  const { data, error } = await storage.download(path);
  if (error) {
    if (storageObjectMissing(error)) return null;
    throw new RecoveryError("pdf_storage_inspection_failed", true);
  }

  let bytes;
  try {
    if (!data || typeof data.arrayBuffer !== "function") {
      throw new Error("Storage returned no readable object");
    }
    bytes = Buffer.from(await data.arrayBuffer());
  } catch {
    throw new RecoveryError("pdf_storage_read_failed", true);
  }

  const actual = artifactIdentity(bytes);
  if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
    throw new RecoveryError("pdf_storage_integrity_mismatch", false);
  }
  return bytes;
}

async function assertLease(db, reference, leaseToken) {
  const { data, error } = await db.rpc("assert_payment_recovery_lease", {
    p_reference: reference,
    p_lease_token: leaseToken
  });
  if (error) throw new RecoveryError("lease_assertion_failed", true);
  return data === true;
}

async function getArtifactManifest(db, reference, leaseToken) {
  const { data, error } = await db.rpc("get_payment_recovery_artifact", {
    p_reference: reference,
    p_lease_token: leaseToken
  });
  if (error) throw new RecoveryError("artifact_manifest_read_failed", true);
  return rpcRow(data);
}

async function recordArtifactManifest(db, reference, leaseToken, identity) {
  const { data, error } = await db.rpc("record_payment_recovery_artifact", {
    p_reference: reference,
    p_lease_token: leaseToken,
    p_artifact_sha256: identity.sha256,
    p_artifact_size_bytes: identity.sizeBytes
  });
  if (error) throw new RecoveryError("artifact_manifest_write_failed", true);
  const manifest = rpcRow(data);
  if (!manifest ||
    manifest.artifact_sha256 !== identity.sha256 ||
    Number(manifest.artifact_size_bytes) !== identity.sizeBytes) {
    throw new RecoveryError("artifact_manifest_conflict", false);
  }
  return manifest;
}

async function createExpectedPdf(generatePdf, audit, manifest = null) {
  let pdf;
  try {
    pdf = generatePdf(audit);
  } catch {
    throw new RecoveryError("pdf_generation_failed", false);
  }
  const identity = artifactIdentity(pdf);
  if (manifest && (
    manifest.artifact_sha256 !== identity.sha256 ||
    Number(manifest.artifact_size_bytes) !== identity.sizeBytes
  )) {
    throw new RecoveryError("artifact_regeneration_mismatch", false);
  }
  return { pdf, identity };
}

async function verifyOrCreateStoredArtifact({ db, storage, pdfPath, manifest, audit, generatePdf, reference, leaseToken }) {
  // A retry with a persisted manifest first inspects the deterministic object.
  // Valid objects are reused without regenerating the PDF.
  if (manifest) {
    const existing = await downloadAndVerifyObject(storage, pdfPath, manifest);
    if (existing) return manifest;
  }

  // No object exists (or no manifest has ever been recorded): generate bytes.
  const generated = await createExpectedPdf(generatePdf, audit, manifest);
  const persisted = manifest || await recordArtifactManifest(
    db, reference, leaseToken, generated.identity
  );

  if (persisted.artifact_sha256 !== generated.identity.sha256 ||
    Number(persisted.artifact_size_bytes) !== generated.identity.sizeBytes) {
    throw new RecoveryError("artifact_manifest_conflict", false);
  }

  const owned = await assertLease(db, reference, leaseToken);
  if (!owned) return null;

  const { error: uploadError } = await storage.upload(pdfPath, generated.pdf, {
    contentType: "application/pdf",
    upsert: false,
    cacheControl: "3600"
  });

  if (uploadError && !/already exists|duplicate/i.test(String(uploadError.message || ""))) {
    throw new RecoveryError("pdf_upload_failed", true);
  }

  // Never trust an upload collision or upload acknowledgement alone. Read the
  // stored bytes back and compare them with the immutable manifest.
  const verified = await downloadAndVerifyObject(storage, pdfPath, persisted);
  if (!verified) throw new RecoveryError("pdf_storage_object_missing_after_upload", true);
  return persisted;
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

    if (!await assertLease(db, reference, leaseToken)) return { status: "lease_lost" };

    const pdfPath = claim.audit_id + "/" + reference + ".pdf";
    const manifest = await getArtifactManifest(db, reference, leaseToken);
    // A missing manifest is represented by an empty RPC result; an empty row
    // with null fields is also treated as absent for a newly claimed job.
    const currentManifest = manifest?.artifact_sha256 && manifest?.artifact_size_bytes
      ? manifest
      : null;

    // Load the audit record without generating a PDF. It is only consumed if
    // the manifest exists but its object is absent, or no manifest exists.
    const { data: audit, error: auditError } = await db.from("audits")
      .select("id,target_url,final_url,strategy,report,created_at")
      .eq("id", claim.audit_id)
      .maybeSingle();
    if (auditError) throw new RecoveryError("audit_lookup_failed", true);
    if (!audit) throw new RecoveryError("audit_missing", false);

    const storage = db.storage.from("audit-reports");
    const persisted = await verifyOrCreateStoredArtifact({
      db,
      storage,
      pdfPath,
      manifest: currentManifest,
      audit,
      generatePdf,
      reference,
      leaseToken
    });
    if (!persisted) return { status: "lease_lost" };

    if (!await assertLease(db, reference, leaseToken)) return { status: "lease_lost" };

    const { data: completed, error: completionError } = await db.rpc(
      "complete_payment_recovery_job",
      {
        p_reference: reference,
        p_lease_token: leaseToken,
        p_transaction_id: String(transaction.id),
        p_pdf_path: pdfPath,
        p_artifact_sha256: persisted.artifact_sha256,
        p_artifact_size_bytes: Number(persisted.artifact_size_bytes)
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
