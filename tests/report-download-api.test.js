import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  REDEMPTION_COOKIE,
  clearRedemptionCookie,
  readCookie,
  readRedemptionCookie,
  reportSessionCookieName,
  setRedemptionCookie,
  setReportSessionCookie,
  sha256Hex
} from "../api/_lib/report-download.js";
import { createReportRedemptionHandler } from "../api/paystack/redeem.js";
import { createReportDownloadHandler } from "../api/reports/[auditId]/download.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const auditId = "decb676a-e5fb-40eb-9ea6-e983b2a4840b";
const token = "a".repeat(64);
const response = () => ({
  statusCode: null, headers: {}, body: null,
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  getHeader(name) { return this.headers[name]; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; }
});

test("cookie helpers scope HttpOnly Secure SameSite cookies and hash secrets", () => {
  const res = response();
  setRedemptionCookie(res, reference, token);
  assert.match(res.headers["Set-Cookie"], new RegExp(REDEMPTION_COOKIE + "=.*Path=/api/paystack"));
  assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(readRedemptionCookie({ headers: { cookie: res.headers["Set-Cookie"].split(";")[0] } }, reference), token);
  assert.equal(readRedemptionCookie({ headers: { cookie: res.headers["Set-Cookie"].split(";")[0] } }, "other-reference"), "");
  clearRedemptionCookie(res);
  assert.match(res.headers["Set-Cookie"][1], /Max-Age=0/);
  assert.equal(sha256Hex(token), createHash("sha256").update(token).digest("hex"));
  assert.equal(readCookie({ headers: { cookie: "x=1; y=two" } }, "y"), "two");
});

test("report session cookie is HttpOnly Secure SameSite=Strict and route-scoped", () => {
  const res = response();
  setReportSessionCookie(res, auditId, token);
  assert.equal(res.headers["Set-Cookie"], reportSessionCookieName(auditId) + "=" + token +
    "; Path=/api/reports/" + auditId + "; Max-Age=3600; HttpOnly; Secure; SameSite=Strict");
});

test("redemption accepts only POST and does not inspect database for invalid references", async () => {
  let processCalls = 0;
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => { throw new Error("invalid reference must not query"); },
    processPayment: async () => { processCalls += 1; return { status: "paid" }; }
  });
  const res = response();
  await handler({ method: "GET", query: { reference } }, res);
  assert.equal(res.statusCode, 405);
  await handler({ method: "POST", body: { reference: "invalid" } }, response());
  assert.equal(processCalls, 0);
});

test("redemption creates a session only after paid status and successful atomic RPC", async () => {
  let rpcArgs;
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { status: "paid", token_expires_at: "2099-01-01T00:00:00Z", delivery_blocked: false }, error: null }) }), rpc: async (name, args) => {
    assert.equal(name, "redeem_report_download");
    rpcArgs = args;
    return { data: [{ audit_id: auditId, session_expires_at: "2099-01-01T00:00:00Z" }], error: null };
  } };
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => db,
    processPayment: async () => ({ status: "paid" }),
    createSessionToken: () => "b".repeat(64)
  });
  const res = response();
  await handler({ method: "POST", body: { reference, recoveryCode: token } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(rpcArgs, {
    p_reference: reference,
    p_token_hash: sha256Hex(token),
    p_session_hash: sha256Hex("b".repeat(64)),
    p_now: rpcArgs.p_now
  });
  assert.equal(res.body.downloadPath, "/api/reports/" + auditId + "/download");
  assert.match(res.headers["Set-Cookie"][0], /Max-Age=0/);
  assert.match(res.headers["Set-Cookie"][1], /__Secure-sitelift-session-/);
  assert.doesNotMatch(JSON.stringify(res.body), /b{64}/);
});

test("pending payment never redeems token or creates session", async () => {
  let rpcCalls = 0;
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { status: "pending", token_expires_at: "2099-01-01T00:00:00Z", delivery_blocked: false }, error: null }) }), rpc: async () => { rpcCalls += 1; return { data: null, error: null }; } };
  const handler = createReportRedemptionHandler({
    getSupabaseAdmin: () => db,
    processPayment: async () => ({ status: "pending" })
  });
  const res = response();
  await handler({ method: "POST", body: { reference, recoveryCode: token } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.downloadReady, false);
  assert.equal(rpcCalls, 0);
});

test("report download revalidates session and streams private storage without signed URLs", async () => {
  let rpcArgs, downloadedPath;
  const db = {
    rpc: async (name, args) => {
      assert.equal(name, "authorize_report_download");
      rpcArgs = args;
      return { data: [{ audit_id: auditId, pdf_path: auditId + "/report.pdf" }], error: null };
    },
    storage: { from(bucket) {
      assert.equal(bucket, "audit-reports");
      return { download: async path => {
        downloadedPath = path;
        return { data: { arrayBuffer: async () => Buffer.from("%PDF-test") }, error: null };
      } };
    } }
  };
  const handler = createReportDownloadHandler({ getSupabaseAdmin: () => db });
  const res = response();
  await handler({
    method: "GET", query: { auditId },
    headers: { cookie: reportSessionCookieName(auditId) + "=" + token }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/pdf");
  assert.equal(res.headers["Cache-Control"], "no-store, private, max-age=0");
  assert.equal(downloadedPath, auditId + "/report.pdf");
  assert.equal(rpcArgs.p_session_hash, sha256Hex(token));
  assert.equal(res.body.toString(), "%PDF-test");
});

test("download without a valid session never queries Supabase", async () => {
  let dbCalls = 0;
  const handler = createReportDownloadHandler({
    getSupabaseAdmin: () => { dbCalls += 1; throw new Error("must not query"); }
  });
  const res = response();
  await handler({ method: "GET", query: { auditId }, headers: { cookie: "" } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(dbCalls, 0);
});
