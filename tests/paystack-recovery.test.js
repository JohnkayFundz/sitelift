import test from "node:test";
import assert from "node:assert/strict";
import { createReportRedemptionHandler } from "../api/paystack/redeem.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const token = "a".repeat(64);
const response = () => ({
  statusCode: null, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  getHeader(name) { return this.headers[name]; },
  json(body) { this.body = body; return this; }
});

test("redemption waits while payment is processing and never creates a session", async () => {
  let dbCalls = 0;
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => { dbCalls += 1; throw new Error("must not issue session"); },
    processPayment: async () => ({ status: "processing" })
  });
  const res = response();
  await handler({ method: "POST", body: { reference, recoveryCode: token } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: "processing", downloadReady: false });
  assert.equal(dbCalls, 0);
});

test("recovery redemption accepts code only in POST body and returns report session path, not signed URL", async () => {
  let rpcCalls = 0;
  const db = { rpc: async (name, args) => {
    rpcCalls += 1;
    assert.equal(name, "redeem_report_download");
    assert.equal(args.p_reference, reference);
    return { data: [{ audit_id: "decb676a-e5fb-40eb-9ea6-e983b2a4840b" }], error: null };
  } };
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => db,
    processPayment: async () => ({ status: "paid" }),
    createSessionToken: () => "b".repeat(64)
  });
  const res = response();
  await handler({ method: "POST", body: { reference, recoveryCode: token } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(rpcCalls, 1);
  assert.equal(res.body.status, "paid");
  assert.equal(res.body.downloadReady, true);
  assert.equal(res.body.downloadPath, "/api/reports/decb676a-e5fb-40eb-9ea6-e983b2a4840b/download");
  assert.equal("downloadUrl" in res.body, false);
  assert.equal("signedUrl" in res.body, false);
});

test("redemption remains POST-only", async () => {
  let processCalls = 0;
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => { throw new Error("GET must not query"); },
    processPayment: async () => { processCalls += 1; return { status: "paid" }; }
  });
  const res = response();
  await handler({ method: "GET", query: { reference } }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
  assert.equal(processCalls, 0);
});
