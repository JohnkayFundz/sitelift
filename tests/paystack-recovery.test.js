import test from "node:test";
import assert from "node:assert/strict";
import { createPaystackVerifyHandler } from "../api/paystack/verify.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const token = "a".repeat(64);

function responseHarness() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

test("authorized recovery retry returns no link while processing and only signs after payment is complete", async () => {
  let processCalls = 0;
  let signedUrlCalls = 0;
  let selectCalls = 0;
  const db = {
    from(table) {
      assert.equal(table, "audit_payments");
      return {
        select() { selectCalls += 1; return this; },
        eq() { return this; },
        maybeSingle: async () => {
          // The first lookup per request authorizes the stored checkout token.
          // The final lookup occurs only after reconciliation reports "paid".
          if (selectCalls <= 2) {
            return {
              data: { status: "pending", token_expires_at: "2099-01-01T00:00:00.000Z" },
              error: null
            };
          }
          return {
            data: {
              status: "paid",
              pdf_path: "audit-test-id/report.pdf",
              download_token: token,
              token_expires_at: "2099-01-01T00:00:00.000Z"
            },
            error: null
          };
        }
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

  const handler = createPaystackVerifyHandler({
    getSupabaseAdmin: () => db,
    processPayment: async incomingReference => {
      assert.equal(incomingReference, reference);
      processCalls += 1;
      return processCalls === 1
        ? { status: "processing", duplicate: true }
        : { status: "paid", pdfPath: "audit-test-id/report.pdf" };
    }
  });

  const firstResponse = responseHarness();
  await handler({ method: "POST", body: { reference, token } }, firstResponse);
  assert.equal(firstResponse.statusCode, 200);
  assert.deepEqual(firstResponse.body, { status: "processing", downloadUrl: null });
  assert.equal(signedUrlCalls, 0, "an in-progress recovery attempt must not create a signed URL");

  const retryResponse = responseHarness();
  await handler({ method: "POST", body: { reference, token } }, retryResponse);
  assert.equal(retryResponse.statusCode, 200);
  assert.deepEqual(retryResponse.body, {
    status: "paid",
    downloadUrl: "https://signed.example/report.pdf",
    expiresIn: 3600
  });
  assert.equal(processCalls, 2, "a later authorized POST may retry reconciliation");
  assert.equal(signedUrlCalls, 1, "a signed URL is created only after paid state and token are rechecked");
  assert.equal(selectCalls, 3);
});

test("recovery verification remains POST-only", async () => {
  let dbCalls = 0;
  const response = responseHarness();
  const handler = createPaystackVerifyHandler({
    getSupabaseAdmin: () => { dbCalls += 1; throw new Error("GET must not access payment state"); },
    processPayment: async () => { throw new Error("GET must not reconcile"); }
  });

  await handler({ method: "GET", body: { reference, token } }, response);

  assert.equal(response.statusCode, 405);
  assert.deepEqual(response.body, { error: "Method not allowed" });
  assert.equal(response.headers.Allow, "POST");
  assert.equal(dbCalls, 0);
});
