import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { processClaimedPaymentRecovery } from "../api/_lib/payment-recovery-worker.js";
import { createPaymentRecoveryDispatcher } from "../api/paystack/recovery-dispatch.js";
import { createPaystackWebhookHandler } from "../api/paystack/webhook.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const leaseToken = "6d8d7e2f-0b1c-4e44-9a10-8fbe0d98b4a1";
const claim = {
  reference,
  lease_token: leaseToken,
  payment_id: "payment-id",
  audit_id: "decb676a-e5fb-40eb-9ea6-e983b2a4840b",
  amount: 250000,
  currency: "NGN",
  attempt_count: 1
};

function response() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

function workerDb({
  leaseAssertions = [true, true, true],
  completion = true,
  initialObject = null,
  initialManifest = null,
  uploadError = null
} = {}) {
  const calls = [];
  let assertionIndex = 0;
  let storedObject = initialObject;
  let manifest = initialManifest;
  const audit = {
    id: claim.audit_id,
    target_url: "https://example.com",
    final_url: "https://example.com/",
    strategy: "mobile",
    created_at: "2026-11-14T00:00:00.000Z",
    report: { scores: [], metrics: [], opportunities: [] }
  };
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "assert_payment_recovery_lease") {
        return { data: leaseAssertions[assertionIndex++], error: null };
      }
      if (name === "get_payment_recovery_artifact") {
        return { data: manifest ? [manifest] : [], error: null };
      }
      if (name === "record_payment_recovery_artifact") {
        const proposed = {
          artifact_sha256: args.p_artifact_sha256,
          artifact_size_bytes: args.p_artifact_size_bytes
        };
        if (manifest && (
          manifest.artifact_sha256 !== proposed.artifact_sha256 ||
          Number(manifest.artifact_size_bytes) !== Number(proposed.artifact_size_bytes)
        )) return { data: [], error: null };
        const created = !manifest;
        manifest ||= proposed;
        return { data: [{ ...manifest, created }], error: null };
      }
      if (name === "complete_payment_recovery_job") {
        return { data: completion, error: null };
      }
      if (name === "fail_payment_recovery_job") {
        return { data: args.p_retryable ? "retry_scheduled" : "dead_letter", error: null };
      }
      throw new Error("Unexpected RPC " + name);
    },
    from(table) {
      assert.equal(table, "audits");
      return {
        select() { return this; },
        eq(column, value) {
          assert.equal(column, "id");
          assert.equal(value, claim.audit_id);
          return this;
        },
        maybeSingle: async () => ({ data: audit, error: null })
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "audit-reports");
        return {
          upload: async (path, pdf, options) => {
            calls.push({ name: "upload", path, pdf, options });
            if (!uploadError) storedObject = Buffer.from(pdf);
            return { error: uploadError };
          },
          download: async (path) => {
            calls.push({ name: "download", path });
            return storedObject
              ? { data: new Blob([storedObject], { type: "application/pdf" }), error: null }
              : { data: null, error: { statusCode: "404", message: "Object not found" } };
          }
        };
      }
    }
  };
  return {
    db, calls,
    get storedObject() { return storedObject; },
    get manifest() { return manifest; },
    setStoredObject(value) { storedObject = value; }
  };
}

test("worker verifies transaction, fences ownership, uploads deterministic PDF and completes via RPC", async () => {
  const { db, calls } = workerDb();
  const result = await processClaimedPaymentRecovery({
    claim,
    db,
    secret: "unit-test-paystack-secret",
    fetchImpl: async (url, options) => {
      assert.match(url, /transaction\/verify\//);
      assert.equal(options.headers.Authorization, "Bearer unit-test-paystack-secret");
      return {
        ok: true,
        json: async () => ({
          status: true,
          data: {
            status: "success",
            reference,
            currency: "NGN",
            amount: 250000,
            id: 987654
          }
        })
      };
    },
    generatePdf: () => Buffer.from("%PDF-1.4\nunit-test")
  });

  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(calls.filter(call => call.name === "assert_payment_recovery_lease").map(call => call.args.p_lease_token), [leaseToken, leaseToken, leaseToken]);
  const upload = calls.find(call => call.name === "upload");
  assert.equal(upload.path, claim.audit_id + "/" + reference + ".pdf");
  assert.equal(upload.options.upsert, false);
  const complete = calls.find(call => call.name === "complete_payment_recovery_job");
  assert.equal(complete.args.p_transaction_id, "987654");
  assert.equal(complete.args.p_pdf_path, upload.path);
  assert.equal(complete.args.p_artifact_sha256, calls.find(call => call.name === "record_payment_recovery_artifact").args.p_artifact_sha256);
  assert.equal(complete.args.p_artifact_size_bytes, upload.pdf.length);
  assert.equal(calls.filter(call => call.name === "download").length, 1);
});

test("worker dead-letters a transaction whose amount or identity does not match", async () => {
  const { db, calls } = workerDb({ leaseAssertions: [] });
  const result = await processClaimedPaymentRecovery({
    claim,
    db,
    secret: "unit-test-paystack-secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          status: "success",
          reference,
          currency: "NGN",
          amount: 1,
          id: 987654
        }
      })
    })
  });

  assert.equal(result.status, "dead_letter");
  const failure = calls.find(call => call.name === "fail_payment_recovery_job");
  assert.equal(failure.args.p_retryable, false);
  assert.equal(failure.args.p_error_code, "provider_transaction_mismatch");
  assert.equal(calls.some(call => call.name === "upload"), false);
});

test("worker stops immediately when the fencing RPC says its lease was lost", async () => {
  const { db, calls } = workerDb({ leaseAssertions: [false] });
  const result = await processClaimedPaymentRecovery({
    claim,
    db,
    secret: "unit-test-paystack-secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          status: "success",
          reference,
          currency: "NGN",
          amount: 250000,
          id: 987654
        }
      })
    })
  });

  assert.deepEqual(result, { status: "lease_lost" });
  assert.equal(calls.some(call => call.name === "upload"), false);
  assert.equal(calls.some(call => call.name === "complete_payment_recovery_job"), false);
  assert.equal(calls.some(call => call.name === "fail_payment_recovery_job"), false);
});


test("retry reuses an existing object only after manifest digest and size verification", async () => {
  const bytes = Buffer.from("%PDF-1.4\\npreviously-uploaded\\n%%EOF");
  const { createHash } = await import("node:crypto");
  const manifest = {
    artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
    artifact_size_bytes: bytes.length
  };
  const harness = workerDb({ initialObject: bytes, initialManifest: manifest, leaseAssertions: [true, true] });
  let generationCalls = 0;
  const result = await processClaimedPaymentRecovery({
    claim, db: harness.db, secret: "unit-test-paystack-secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: "success", reference, currency: "NGN", amount: 250000, id: 987654 } })
    }),
    generatePdf: () => { generationCalls += 1; return Buffer.from("%PDF-1.4\\nshould-not-be-used\\n%%EOF"); }
  });
  assert.deepEqual(result, { status: "completed" });
  assert.equal(generationCalls, 0);
  assert.equal(harness.calls.some(call => call.name === "upload"), false);
  assert.equal(harness.calls.some(call => call.name === "record_payment_recovery_artifact"), false);
});

test("existing object with mismatched digest fails closed before payment completion", async () => {
  const { createHash } = await import("node:crypto");
  const expected = Buffer.from("%PDF-1.4\\nexpected\\n%%EOF");
  const actual = Buffer.from("%PDF-1.4\\ntampered\\n%%EOF");
  const manifest = {
    artifact_sha256: createHash("sha256").update(expected).digest("hex"),
    artifact_size_bytes: expected.length
  };
  const { db, calls } = workerDb({ initialObject: actual, initialManifest: manifest, leaseAssertions: [true] });
  const result = await processClaimedPaymentRecovery({
    claim, db, secret: "unit-test-paystack-secret",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: "success", reference, currency: "NGN", amount: 250000, id: 987654 } })
    }),
    generatePdf: () => { throw new Error("must not regenerate over an integrity mismatch"); }
  });
  assert.equal(result.status, "dead_letter");
  assert.equal(result.errorCode, "pdf_storage_integrity_mismatch");
  assert.equal(calls.some(call => call.name === "complete_payment_recovery_job"), false);
  assert.equal(calls.some(call => call.name === "upload"), false);
});
\ntest("dispatcher requires the configured bearer secret and invokes a one-job bounded batch", async () => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "c".repeat(48);
  let calls = 0;
  let receivedOptions;
  const handler = createPaymentRecoveryDispatcher({
    runBatch: async options => {
      calls += 1;
      receivedOptions = options;
      return { claimed: 1, completed: 1, retried: 0, deadLettered: 0, leaseLost: 0, failures: 0 };
    }
  });

  try {
    const denied = response();
    await handler({ method: "GET", headers: {} }, denied);
    assert.equal(denied.statusCode, 401);
    assert.equal(calls, 0);

    const accepted = response();
    await handler({ method: "GET", headers: { authorization: "Bearer " + process.env.CRON_SECRET } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(calls, 1);
    assert.equal(receivedOptions.maxJobs, 1);
    assert.equal(receivedOptions.budgetMs, 45000);
    assert.equal(accepted.body.completed, 1);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test("webhook returns retryable failure when durable enqueue does not accept the event", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const secret = "unit-test-paystack-secret";
  process.env.PAYSTACK_SECRET_KEY = secret;
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference } }));
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  const handler = createPaystackWebhookHandler({
    getSupabaseAdmin: () => ({
      rpc: async (name) => {
        assert.equal(name, "enqueue_payment_recovery_job");
        return { data: [{ accepted: false, duplicate: false, already_paid: false }], error: null };
      }
    })
  });

  try {
    const res = response();
    await handler({ method: "POST", headers: { "x-paystack-signature": signature }, body: raw }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "Payment recovery could not be durably queued" });
  } finally {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});
