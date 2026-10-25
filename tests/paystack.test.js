import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPaystackWebhookHandler, validSignature } from "../api/paystack/webhook.js";
import { createAuditPdf, processVerifiedPaystackPayment } from "../api/_lib/server.js";
import { createPaymentStatusHandler } from "../api/paystack/status.js";
test("Paystack webhook signature validates the exact raw body", () => {
  const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "test-reference" } }));
  const secret = "test-secret-for-unit-tests";
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  assert.equal(validSignature(raw, signature, secret), true);
  assert.equal(validSignature(Buffer.from(raw.toString() + " "), signature, secret), false);
  assert.equal(validSignature(raw, "not-a-signature", secret), false);
});
test("PDF generator emits a minimal PDF document", () => {
  const pdf = createAuditPdf({ target_url: "https://example.com", final_url: "https://example.com/", strategy: "mobile", created_at: "2026-10-17T00:00:00.000Z", report: { scores: [{ label: "Performance", value: 91 }], metrics: [], opportunities: [] } });
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.equal(pdf.toString("utf8").includes("Performance: 91/100"), true);
  assert.equal(pdf.toString("utf8").endsWith("%%EOF"), true);
});

test("webhook processing claims a payment atomically and acknowledges in-progress duplicates", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../api/_lib/server.js", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../api/paystack/webhook.js", import.meta.url), "utf8");
  assert.match(server, /status\.eq\.pending,status\.eq\.initialization_unknown,and\(status\.eq\.processing,processing_started_at\.lt\./);
  assert.match(server, /\.eq\("status", "processing"\)\.eq\("processing_started_at", nowIso\)/);
  assert.match(webhook, /result\.status === "processing"[\s\S]*?json\(res, 200,[\s\S]*?duplicate: true/);
});

test("expired tokens have a distinct reason and the recovery endpoint only emails the stored checkout address", async () => {
  const { readFile } = await import("node:fs/promises");
  const status = await readFile(new URL("../api/paystack/status.js", import.meta.url), "utf8");
  const recovery = await readFile(new URL("../api/paystack/resend-link.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(status, /reason: "expired_token"/);
  assert.match(app, /Your 24-hour download link has expired/);
  assert.ok(app.includes('"/api/paystack/resend-link"'));
  assert.match(recovery, /to: \[payment\.customer_email\]/);
  assert.match(recovery, /const GENERIC_MESSAGE = "If the reference and email match a paid record/);
  assert.doesNotMatch(recovery, /downloadUrl:\s*link\.toString\(\)/);
});

test("duplicate charge.success webhook leaves an existing paid record immutable", async () => {
  const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
  const secret = "unit-test-paystack-secret";
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = secret;

  const payment = {
    id: "payment-test-id",
    audit_id: "audit-test-id",
    reference,
    amount: 250000,
    currency: "NGN",
    status: "paid",
    pdf_path: "/reports/test.pdf",
    paid_at: "2026-10-20T12:34:56.000Z",
    webhook_processed_at: "2026-10-20T12:34:57.000Z",
    download_token: "token_abc123",
    token_expires_at: "2099-01-01T00:00:00.000Z",
    processing_started_at: null
  };
  const originalPayment = structuredClone(payment);
  let updateCalls = 0;
  let pdfCalls = 0;
  let uploadCalls = 0;
  const query = {
    select() { return this; },
    eq(column, value) {
      if (column === "reference") assert.equal(value, reference);
      return this;
    },
    maybeSingle: async () => ({ data: structuredClone(payment), error: null }),
    update() {
      updateCalls += 1;
      return this;
    }
  };
  const db = {
    from(table) {
      assert.equal(table, "audit_payments");
      return query;
    },
    storage: {
      from() {
        return {
          upload() {
            uploadCalls += 1;
            throw new Error("Duplicate processing must not upload a PDF");
          }
        };
      }
    }
  };

  try {
    const handler = createPaystackWebhookHandler({
      processPayment: (incomingReference) => processVerifiedPaystackPayment(incomingReference, {
        supabaseAdmin: () => db,
        createAuditPdf: () => {
          pdfCalls += 1;
          throw new Error("Duplicate processing must not generate a PDF");
        }
      })
    });
    const raw = Buffer.from(JSON.stringify({
      event: "charge.success",
      data: { reference, status: "success", amount: 250000, currency: "NGN" }
    }));
    const signature = createHmac("sha512", secret).update(raw).digest("hex");
    const response = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name] = value; },
      json(body) { this.body = body; return this; }
    };

    await handler({
      method: "POST",
      headers: { "x-paystack-signature": signature },
      body: raw
    }, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { received: true, duplicate: true });
    assert.equal(updateCalls, 0, "Supabase update must never be called for a complete paid record");
    assert.equal(pdfCalls, 0, "PDF generation must never run for a complete paid record");
    assert.equal(uploadCalls, 0, "PDF storage upload must never run for a complete paid record");
    assert.deepEqual(payment, originalPayment, "critical payment fields remain unchanged");
  } finally {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});


test("GET payment status is read-only and never invokes payment reconciliation or signed-link creation", async () => {
  const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
  const token = "a".repeat(64);
  let updateCalls = 0;
  let signedUrlCalls = 0;
  let selectCalls = 0;
  const query = {
    select() { selectCalls += 1; return this; },
    eq() { return this; },
    maybeSingle: async () => ({
      data: { status: "pending", pdf_path: null, token_expires_at: "2099-01-01T00:00:00.000Z" },
      error: null
    }),
    update() { updateCalls += 1; throw new Error("GET status must not write"); }
  };
  const db = {
    from(table) {
      assert.equal(table, "audit_payments");
      return query;
    },
    storage: {
      from() {
        return { createSignedUrl() { signedUrlCalls += 1; throw new Error("GET status must not create signed URLs"); } };
      }
    }
  };
  const response = {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  const { readFile } = await import("node:fs/promises");
  const statusSource = await readFile(new URL("../api/paystack/status.js", import.meta.url), "utf8");
  assert.doesNotMatch(statusSource, /processVerifiedPaystackPayment/);
  assert.doesNotMatch(statusSource, /createSignedUrl/);
  const handler = createPaymentStatusHandler({ getSupabaseAdmin: () => db });

  await handler({ method: "GET", query: { reference, token } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: "pending", downloadReady: false, downloadUrl: null });
  assert.equal(selectCalls, 1);
  assert.equal(updateCalls, 0);
  assert.equal(signedUrlCalls, 0);
});


test("webhook rejects invalid signatures without invoking payment processing", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  let processCalls = 0;
  const response = {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  try {
    const handler = createPaystackWebhookHandler({
      processPayment: async () => { processCalls += 1; return { status: "paid" }; }
    });
    await handler({
      method: "POST",
      headers: { "x-paystack-signature": "0".repeat(128) },
      body: Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "fake" } }))
    }, response);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Invalid webhook signature" });
    assert.equal(processCalls, 0);
  } finally {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});

test("webhook acknowledges unrelated events without processing a payment", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const secret = "unit-test-paystack-secret";
  process.env.PAYSTACK_SECRET_KEY = secret;
  const raw = Buffer.from(JSON.stringify({ event: "transfer.success", data: { reference: "not-a-payment" } }));
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  let processCalls = 0;
  const response = {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  try {
    const handler = createPaystackWebhookHandler({
      processPayment: async () => { processCalls += 1; return { status: "paid" }; }
    });
    await handler({ method: "POST", headers: { "x-paystack-signature": signature }, body: raw }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { received: true });
    assert.equal(processCalls, 0);
  } finally {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});

test("explicit payment verification creates a signed download only after token authorization and paid state", async () => {
  const { createPaystackVerifyHandler } = await import("../api/paystack/verify.js");
  const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
  const token = "a".repeat(64);
  const queryResults = [
    { data: { status: "pending", token_expires_at: "2099-01-01T00:00:00.000Z" }, error: null },
    { data: { status: "paid", pdf_path: "audit-test-id/report.pdf", download_token: token, token_expires_at: "2099-01-01T00:00:00.000Z" }, error: null }
  ];
  let queryIndex = 0;
  let processCalls = 0;
  let signedUrlCalls = 0;
  const db = {
    from(table) {
      assert.equal(table, "audit_payments");
      const result = queryResults[queryIndex++];
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => result
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "audit-reports");
        return {
          createSignedUrl: async (path, expiresIn, options) => {
            signedUrlCalls += 1;
            assert.equal(path, "audit-test-id/report.pdf");
            assert.equal(expiresIn, 3600);
            assert.deepEqual(options, { download: true });
            return { data: { signedUrl: "https://signed.example/report.pdf" }, error: null };
          }
        };
      }
    }
  };
  const response = {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  const handler = createPaystackVerifyHandler({
    getSupabaseAdmin: () => db,
    processPayment: async incomingReference => {
      processCalls += 1;
      assert.equal(incomingReference, reference);
      return { status: "paid" };
    }
  });

  await handler({ method: "POST", body: { reference, token } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: "paid",
    downloadUrl: "https://signed.example/report.pdf",
    expiresIn: 3600
  });
  assert.equal(processCalls, 1);
  assert.equal(signedUrlCalls, 1);
  assert.equal(queryIndex, 2);
});

test("explicit payment verification refuses an invalid token before reconciliation", async () => {
  const { createPaystackVerifyHandler } = await import("../api/paystack/verify.js");
  let processCalls = 0;
  let dbCalls = 0;
  const response = {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
  const handler = createPaystackVerifyHandler({
    getSupabaseAdmin: () => { dbCalls += 1; throw new Error("invalid input must not access DB"); },
    processPayment: async () => { processCalls += 1; return { status: "paid" }; }
  });

  await handler({ method: "POST", body: { reference: "invalid", token: "invalid" } }, response);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: "A valid download token is required" });
  assert.equal(dbCalls, 0);
  assert.equal(processCalls, 0);
});


test("concurrent webhook delivery sees the real processing claim, and a failed worker can be retried", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  const secret = "unit-test-paystack-secret";
  process.env.PAYSTACK_SECRET_KEY = secret;
  const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
  let releaseFirstVerification;
  let firstVerificationStarted;
  const firstStarted = new Promise(resolve => { firstVerificationStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirstVerification = resolve; });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      firstVerificationStarted();
      await firstGate;
    }
    return { ok: true, json: async () => ({ status: true, data: {
      status: "success", reference, currency: "NGN", amount: 250000, id: 123
    } }) };
  };
  const h = paymentProcessingHarness({ uploadError: { message: "storage unavailable" } });
  const handler = createPaystackWebhookHandler({
    processPayment: incomingReference => processVerifiedPaystackPayment(incomingReference, {
      supabaseAdmin: () => h.db,
      createAuditPdf: () => Buffer.from("%PDF-test")
    })
  });
  const makeResponse = () => ({
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  });
  const raw = Buffer.from(JSON.stringify({
    event: "charge.success",
    data: { reference, status: "success", amount: 250000, currency: "NGN" }
  }));
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  const req = { method: "POST", headers: { "x-paystack-signature": signature }, body: raw };

  try {
    const firstResponse = makeResponse();
    const firstDelivery = handler(req, firstResponse);
    await firstStarted;

    const duplicateResponse = makeResponse();
    await handler(req, duplicateResponse);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.deepEqual(duplicateResponse.body, { received: true, duplicate: true, processing: true });
    assert.equal(fetchCalls, 1, "the duplicate must not start a second Paystack verification while the claim is active");

    releaseFirstVerification();
    await firstDelivery;
    assert.equal(firstResponse.statusCode, 500, "the first worker's storage failure should be retryable");
    assert.equal(h.payment.status, "pending", "failed work should release the processing claim");
    assert.equal(h.payment.processing_started_at, null);

    h.setUploadError(null);
    const retryResponse = makeResponse();
    await handler(req, retryResponse);
    assert.equal(retryResponse.statusCode, 200);
    assert.deepEqual(retryResponse.body, { received: true, duplicate: false });
    assert.equal(h.payment.status, "paid", "a later delivery should complete using the real payment processor");
    assert.equal(h.payment.processing_started_at, null);
    assert.equal(fetchCalls, 2);
  } finally {
    releaseFirstVerification();
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});

function paymentProcessingHarness({
  uploadError: initialUploadError = null,
  paymentOverrides = {}
} = {}) {
  let uploadError = initialUploadError;
  let uploadCalls = 0;

  const payment = {
    id: "payment-1",
    audit_id: "audit-1",
    amount: 250000,
    currency: "NGN",
    status: "pending",
    pdf_path: null,
    download_token: "a".repeat(64),
    token_expires_at: "2099-01-01T00:00:00.000Z",
    processing_started_at: null,
    reference:
      "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9",
    ...paymentOverrides
  };

  // Preserve existing test semantics: successful mutations only.
  const updates = [];
  const updateAttempts = [];
  const successfulUpdates = [];
  const rejectedUpdates = [];

  function matchesUpdate(filters, orFilter) {
    const basicMatch = filters.every(
      ([key, value]) => payment[key] === value
    );

    if (!basicMatch) return false;
    if (!orFilter) return true;

    if (orFilter === "download_token.is.null,token_expires_at.is.null") {
      return (
        payment.download_token == null ||
        payment.token_expires_at == null
      );
    }

    const staleMatch = orFilter.match(
      /processing_started_at\.lt\.([^,)]+)/
    );

    return (
      (orFilter.includes("status.eq.pending") &&
        payment.status === "pending") ||
      (orFilter.includes("status.eq.initialization_unknown") &&
        payment.status === "initialization_unknown") ||
      (orFilter.includes("status.eq.processing") &&
        payment.status === "processing" &&
        payment.processing_started_at != null &&
        staleMatch != null &&
        Date.parse(payment.processing_started_at) <
          Date.parse(staleMatch[1]))
    );
  }

  function recordUpdateAttempt(filters, orFilter, values) {
    const matched = matchesUpdate(filters, orFilter);
    const attempt = {
      filters: structuredClone(filters),
      orFilter,
      values: structuredClone(values),
      matched
    };

    updateAttempts.push(attempt);

    if (!matched) {
      rejectedUpdates.push(attempt);
      return false;
    }

    Object.assign(payment, structuredClone(values));
    updates.push(structuredClone(values));
    successfulUpdates.push(attempt);
    return true;
  }

  const db = {
    from(table) {
      if (table === "audit_payments") {
        return {
          select() {
            const filters = [];

            return {
              eq(key, value) {
                filters.push([key, value]);
                return this;
              },

              maybeSingle: async () => ({
                data: filters.some(
                  ([key, value]) => payment[key] !== value
                )
                  ? null
                  : structuredClone(payment),
                error: null
              })
            };
          },

          update(values) {
            const filters = [];
            let orFilter = null;
            let wantsRow = false;

            const query = {
              eq(key, value) {
                filters.push([key, value]);
                return this;
              },

              or(value) {
                orFilter = value;
                return this;
              },

              select() {
                wantsRow = true;
                return this;
              },

              async maybeSingle() {
                const matched = recordUpdateAttempt(
                  filters,
                  orFilter,
                  values
                );

                if (!matched) {
                  return { data: null, error: null };
                }

                return {
                  data: wantsRow ? { id: payment.id } : null,
                  error: null
                };
              },

              then(resolve, reject) {
                recordUpdateAttempt(filters, orFilter, values);
                return Promise.resolve({ error: null }).then(
                  resolve,
                  reject
                );
              }
            };

            return query;
          }
        };
      }

      if (table === "audits") {
        return {
          select() {
            return this;
          },

          eq() {
            return this;
          },

          single: async () => ({
            data: {
              id: "audit-1",
              target_url: "https://example.com",
              final_url: "https://example.com/",
              strategy: "mobile",
              created_at: "2026-10-20T00:00:00.000Z",
              report: {
                scores: [],
                metrics: [],
                opportunities: []
              }
            },
            error: null
          })
        };
      }

      throw new Error("Unexpected table " + table);
    },

    storage: {
      from(bucket) {
        assert.equal(bucket, "audit-reports");

        return {
          upload: async () => {
            uploadCalls += 1;
            return { error: uploadError };
          }
        };
      }
    }
  };

  return {
    db,
    payment,
    updates,
    updateAttempts,
    successfulUpdates,
    rejectedUpdates,
    get uploadCalls() {
      return uploadCalls;
    },
    setUploadError(value) {
      uploadError = value;
    }
  };
}

function installControlledClock(initialTime) {
  const RealDate = globalThis.Date;
  let currentTime = initialTime;

  globalThis.Date = class ControlledDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [currentTime]));
    }

    static now() {
      return currentTime;
    }
  };

  return {
    advance(milliseconds) {
      currentTime += milliseconds;
    },

    restore() {
      globalThis.Date = RealDate;
    }
  };
}

test("stale worker cannot reset a newer worker's processing claim", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  const clock = installControlledClock(
    new Date("2026-10-24T12:00:00.000Z").getTime()
  );

  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";

  const reference =
    "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";

  let fetchCalls = 0;
  let releaseA;
  let releaseB;
  let startedA;
  let startedB;

  const gateA = new Promise(resolve => {
    releaseA = resolve;
  });

  const gateB = new Promise(resolve => {
    releaseB = resolve;
  });

  const firstStarted = new Promise(resolve => {
    startedA = resolve;
  });

  const secondStarted = new Promise(resolve => {
    startedB = resolve;
  });

  globalThis.fetch = async () => {
    fetchCalls += 1;

    if (fetchCalls === 1) {
      startedA();
      await gateA;

      return {
        ok: true,
        json: async () => ({
          status: true,
          data: {
            status: "pending",
            reference,
            currency: "NGN",
            amount: 250000,
            id: 123
          }
        })
      };
    }

    startedB();
    await gateB;

    return {
      ok: true,
      json: async () => ({
        status: true,
        data: {
          status: "success",
          reference,
          currency: "NGN",
          amount: 250000,
          id: 124
        }
      })
    };
  };

  const h = paymentProcessingHarness();
  let pdfCalls = 0;

  const runPayment = () =>
    processVerifiedPaystackPayment(reference, {
      supabaseAdmin: () => h.db,
      createAuditPdf: () => {
        pdfCalls += 1;
        return Buffer.from("%PDF-test");
      }
    });

  const originalError = console.error;
  console.error = () => {};

  try {
    const workerA = runPayment();
    await firstStarted;

    const timestampA = h.payment.processing_started_at;
    clock.advance(180001);

    const workerB = runPayment();
    await secondStarted;

    const timestampB = h.payment.processing_started_at;
    assert.notEqual(timestampA, timestampB);
    assert.equal(h.payment.status, "processing");

    releaseA();
    const resultA = await workerA;

    assert.deepEqual(resultA, {
      status: "processing",
      duplicate: true
    });
    assert.equal(h.payment.status, "processing");
    assert.equal(h.payment.processing_started_at, timestampB);
    assert.equal(pdfCalls, 0, "the stale worker must stop before PDF generation");

    releaseB();
    const resultB = await workerB;

    assert.equal(resultB.status, "paid");
    assert.equal(h.payment.status, "paid");
    assert.equal(h.payment.processing_started_at, null);
    assert.equal(pdfCalls, 1, "only the current owner should generate a PDF");
  } finally {
    releaseA();
    releaseB();
    console.error = originalError;
    globalThis.fetch = originalFetch;
    clock.restore();

    if (originalSecret === undefined) {
      delete process.env.PAYSTACK_SECRET_KEY;
    } else {
      process.env.PAYSTACK_SECRET_KEY = originalSecret;
    }
  }
});

test("stale worker cannot overwrite a newer worker's completed payment", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  const clock = installControlledClock(
    new Date("2026-10-24T12:00:00.000Z").getTime()
  );

  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";

  const reference =
    "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";

  let fetchCalls = 0;
  let releaseA;
  let releaseB;
  let startedA;
  let startedB;

  const gateA = new Promise(resolve => {
    releaseA = resolve;
  });

  const gateB = new Promise(resolve => {
    releaseB = resolve;
  });

  const firstStarted = new Promise(resolve => {
    startedA = resolve;
  });

  const secondStarted = new Promise(resolve => {
    startedB = resolve;
  });

  globalThis.fetch = async () => {
    fetchCalls += 1;
    const isWorkerA = fetchCalls === 1;

    if (isWorkerA) {
      startedA();
      await gateA;
    } else {
      startedB();
      await gateB;
    }

    return {
      ok: true,
      json: async () => ({
        status: true,
        data: {
          status: "success",
          reference,
          currency: "NGN",
          amount: 250000,
          id: isWorkerA ? 123 : 124
        }
      })
    };
  };

  const h = paymentProcessingHarness();
  let pdfCalls = 0;

  const runPayment = () =>
    processVerifiedPaystackPayment(reference, {
      supabaseAdmin: () => h.db,
      createAuditPdf: () => {
        pdfCalls += 1;
        return Buffer.from("%PDF-test");
      }
    });

  try {
    const workerA = runPayment();
    await firstStarted;

    const timestampA = h.payment.processing_started_at;
    clock.advance(180001);

    const workerB = runPayment();
    await secondStarted;

    const timestampB = h.payment.processing_started_at;
    assert.notEqual(timestampA, timestampB);

    releaseB();
    const resultB = await workerB;

    assert.equal(resultB.status, "paid");
    assert.equal(h.payment.status, "paid");
    assert.equal(h.payment.processing_started_at, null);

    const paidAtB = h.payment.paid_at;
    const transactionIdB = h.payment.paystack_transaction_id;
    const pdfPathB = h.payment.pdf_path;

    releaseA();
    const resultA = await workerA;

    assert.deepEqual(resultA, {
      status: "processing",
      duplicate: true
    });

    assert.equal(h.payment.status, "paid");
    assert.equal(h.payment.processing_started_at, null);
    assert.equal(h.payment.paid_at, paidAtB);
    assert.equal(
      h.payment.paystack_transaction_id,
      transactionIdB
    );
    assert.equal(h.payment.pdf_path, pdfPathB);

    assert.equal(
      h.rejectedUpdates.some(
        attempt =>
          attempt.values.status === "paid" &&
          attempt.filters.some(
            ([key, value]) =>
              key === "processing_started_at" &&
              value === timestampA
          )
      ),
      false,
      "the stale worker should stop before attempting payment completion"
    );

    assert.equal(
      pdfCalls,
      1,
      "the stale worker must not generate a PDF after B completes"
    );
    assert.equal(
      h.uploadCalls,
      1,
      "the stale worker must not attempt a PDF upload after B completes"
    );
  } finally {
    releaseA();
    releaseB();
    globalThis.fetch = originalFetch;
    clock.restore();

    if (originalSecret === undefined) {
      delete process.env.PAYSTACK_SECRET_KEY;
    } else {
      process.env.PAYSTACK_SECRET_KEY = originalSecret;
    }
  }
});

test("processing claim exactly at the stale cutoff is not reclaimed", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;

  const now = new Date("2026-10-24T12:00:00.000Z");
  const cutoff = new Date(now.getTime() - 180000).toISOString();
  const clock = installControlledClock(now.getTime());

  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";

  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;

    return {
      ok: true,
      json: async () => ({
        status: true,
        data: {
          status: "success",
          reference:
            "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9",
          currency: "NGN",
          amount: 250000,
          id: 123
        }
      })
    };
  };

  const h = paymentProcessingHarness({
    paymentOverrides: {
      status: "processing",
      processing_started_at: cutoff
    }
  });

  try {
    const result = await processVerifiedPaystackPayment(
      h.payment.reference,
      {
        supabaseAdmin: () => h.db,
        createAuditPdf: () => Buffer.from("%PDF-test")
      }
    );

    assert.deepEqual(result, {
      status: "processing",
      duplicate: true
    });

    assert.equal(h.payment.status, "processing");
    assert.equal(h.payment.processing_started_at, cutoff);
    assert.equal(fetchCalls, 0);
    assert.equal(h.successfulUpdates.length, 0);
    assert.equal(h.rejectedUpdates.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();

    if (originalSecret === undefined) {
      delete process.env.PAYSTACK_SECRET_KEY;
    } else {
      process.env.PAYSTACK_SECRET_KEY = originalSecret;
    }
  }
});

test("payment processing releases its atomic claim when PDF storage fails", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: {
    status: "success",
    reference: "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9",
    currency: "NGN", amount: 250000, id: 123
  } }) });
  const h = paymentProcessingHarness({ uploadError: { message: "storage unavailable" } });
  const oldError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      processVerifiedPaystackPayment(h.payment.reference, { supabaseAdmin: () => h.db, createAuditPdf: () => Buffer.from("%PDF-test") }),
      error => error?.message === "storage unavailable"
    );
    assert.equal(h.payment.status, "pending", "failed PDF upload should return the payment to pending");
    assert.equal(h.payment.processing_started_at, null, "failed processing should release its claim");
    assert.equal(h.updates.length, 2, "one claim and one conditional claim reset should occur");
  } finally {
    console.error = oldError;
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});

test("verified successful payments can be reconciled from an uncertain initialization state", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: {
    status: "success",
    reference: "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9",
    currency: "NGN", amount: 250000, id: 123
  } }) });
  const h = paymentProcessingHarness({ paymentOverrides: { status: "initialization_unknown" } });
  try {
    const result = await processVerifiedPaystackPayment(h.payment.reference, {
      supabaseAdmin: () => h.db,
      createAuditPdf: () => Buffer.from("%PDF-test")
    });
    assert.equal(result.status, "paid");
    assert.equal(h.payment.status, "paid");
    assert.equal(h.payment.processing_started_at, null);
    assert.equal(h.updates[0].status, "processing");
    assert.equal(h.updates[1].status, "paid");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});

test("unconfirmed Paystack transactions release the processing claim without generating or uploading a PDF", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: {
    status: "pending",
    reference: "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9",
    currency: "NGN", amount: 250000, id: 123
  } }) });
  const h = paymentProcessingHarness();
  let pdfCalls = 0;
  try {
    const result = await processVerifiedPaystackPayment(h.payment.reference, {
      supabaseAdmin: () => h.db,
      createAuditPdf: () => { pdfCalls += 1; return Buffer.from("%PDF-test"); }
    });
    assert.deepEqual(result, { status: "pending" });
    assert.equal(h.payment.status, "pending");
    assert.equal(h.payment.processing_started_at, null);
    assert.equal(h.updates.length, 2, "claim and reset are both recorded");
    assert.equal(pdfCalls, 0, "an unconfirmed transaction must not generate a report");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});


test("webhook enforces the 1 MB body limit for Buffer, string, and streamed requests", async () => {
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  const oversized = "x".repeat(1024 * 1024 + 1);
  let processCalls = 0;
  const handler = createPaystackWebhookHandler({
    processPayment: async () => { processCalls += 1; return { status: "paid" }; }
  });
  const makeResponse = () => ({
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  });
  const requests = [
    { method: "POST", headers: {}, body: Buffer.from(oversized) },
    { method: "POST", headers: {}, body: oversized },
    { method: "POST", headers: {}, async *[Symbol.asyncIterator]() {
      yield Buffer.from(oversized.slice(0, 600000));
      yield Buffer.from(oversized.slice(600000));
    } }
  ];

  try {
    for (const request of requests) {
      const response = makeResponse();
      await handler(request, response);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { error: "Invalid webhook body" });
    }
    assert.equal(processCalls, 0, "oversized request bodies must never invoke payment processing");
  } finally {
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});


test("SiteLift payment migration includes every field and status used by payment handlers", async () => {
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(new URL("../supabase/migrations/202610170001_sitelift_audits_payments.sql", import.meta.url), "utf8");
  assert.match(migration, /status text not null default 'pending' check \(status in \('pending','processing','initialization_unknown','initialization_failed','paid'\)\)/);
  assert.match(migration, /download_token text/);
  assert.match(migration, /token_expires_at timestamptz/);
  assert.match(migration, /processing_started_at timestamptz/);
});
