import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPaystackWebhookHandler, validSignature } from "../api/paystack/webhook.js";
import { createAuditPdf, processVerifiedPaystackPayment } from "../api/_lib/server.js";
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
  assert.match(server, /status\.eq\.pending,and\(status\.eq\.processing,processing_started_at\.lt\./);
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
