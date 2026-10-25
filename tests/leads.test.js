import test from "node:test";
import assert from "node:assert/strict";
import { createLeadCaptureHandler, parsePublicWebsiteUrl } from "../api/leads/capture.js";
import { processChecklistDeliveryJob } from "../api/_lib/delivery.js";

const auditId = "decb676a-e5fb-40eb-9ea6-e983b2a4840b";
const input = {
  email: "Owner@Example.com",
  businessName: "Example Shop",
  websiteUrl: "https://example.com/",
  auditId,
  source: "mobile-speed-lagos",
  landingPage: "/check/mobile-speed-lagos",
  marketingConsent: false
};

function response() {
  return {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

function dbHarness({ audit = { id: auditId, target_url: "https://example.com/", final_url: "https://example.com/" }, rpcResult = [{ lead_id: "lead-1", delivery_job_id: "job-1", idempotent: false }], rpcError = null } = {}) {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, "audits");
      return {
        select(fields) { calls.push(["select", fields]); return this; },
        eq(key, value) { calls.push(["eq", key, value]); return this; },
        async maybeSingle() { return { data: audit, error: null }; }
      };
    },
    async rpc(name, args) {
      calls.push(["rpc", name, args]);
      const callNumber = calls.filter(call => call[0] === "rpc").length;
      const resolved = typeof rpcResult === "function" ? rpcResult(callNumber, args) : rpcResult;
      return { data: resolved, error: rpcError };
    }
  };
  return { db, calls };
}

function handlerHarness({ rate = { success: true, limit: 5, remaining: 4 }, rateError = null, dbState = {} } = {}) {
  const state = dbHarness(dbState), rateKeys = [];
  const handler = createLeadCaptureHandler({
    getSupabaseAdmin: () => state.db,
    createRateLimiter: () => ({
      limit: async key => {
        rateKeys.push(key);
        if (rateError) throw rateError;
        return rate;
      }
    }),
    now: () => new Date("2026-10-25T10:00:00.000Z")
  });
  return { handler, ...state, rateKeys };
}

const req = (body = input, extra = {}) => ({
  method: "POST", headers: { "x-real-ip": "203.0.113.8" }, socket: { remoteAddress: "127.0.0.1" },
  body, ...extra
});

test("valid lead submission persists atomically and returns durable queued lead ID", async () => {
  const h = handlerHarness(), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    success: true, leadId: "lead-1",
    checklist: { status: "queued" },
    message: "Your checklist request has been received."
  });
  const rpc = h.calls.find(call => call[0] === "rpc");
  assert.equal(rpc[1], "capture_sitelift_lead");
  assert.equal(rpc[2].p_email, "owner@example.com");
  assert.equal(rpc[2].p_marketing_consent, false);
  assert.equal(rpc[2].p_consent_recorded_at, null);
  assert.equal(rpc[2].p_website_url, "https://example.com/");
});

test("repeated idempotent submission returns existing durable lead without changing consent", async () => {
  const h = handlerHarness({ dbState: { rpcResult: (callNumber) => [{
    lead_id: "lead-existing", delivery_job_id: "job-existing", idempotent: callNumber > 1
  }] } });
  const a = response(), b = response();
  await h.handler(req(), a);
  await h.handler(req({ ...input, marketingConsent: true }), b);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(a.body.leadId, b.body.leadId);
  const calls = h.calls.filter(call => call[0] === "rpc");
  assert.equal(calls[0][2].p_idempotency_key, calls[1][2].p_idempotency_key);
  assert.equal(calls[1][2].p_marketing_consent, true, "SQL idempotency path must not mutate existing consent");
});

test("invalid email is rejected before rate limiter or database access", async () => {
  const h = handlerHarness(), res = response();
  await h.handler(req({ ...input, email: "not-an-email" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(h.calls.length, 0);
  assert.equal(h.rateKeys.length, 0);
});

test("malformed URLs, IP literals, loopback and metadata endpoints are rejected", () => {
  for (const url of [
    "not a URL", "file:///etc/passwd", "http://127.0.0.1", "http://2130706433/",
    "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/", "http://localhost/", "http://private.local/",
    "https://user:pass@example.com/", "https://example.com:8443/"
  ]) {
    assert.equal(parsePublicWebsiteUrl(url), null, url);
  }
  assert.ok(parsePublicWebsiteUrl("https://example.com/shop"));
});

test("audit ID must correlate to target or final audited hostname", async () => {
  const h = handlerHarness(), res = response();
  await h.handler(req({ ...input, websiteUrl: "https://evil.com/" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /match the website recorded/);
  assert.equal(h.calls.some(call => call[0] === "rpc"), false);
});

test("rate limit returns HTTP 429 and does not touch database", async () => {
  const h = handlerHarness({ rate: { success: false, limit: 5, remaining: 0, reset: Date.now() + 60000 } }), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"] > 0, true);
  assert.equal(h.calls.length, 0);
});

test("Upstash failure is fail-closed with HTTP 503", async () => {
  const h = handlerHarness({ rateError: new Error("private redis endpoint or credential") }), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /private redis endpoint|credential/);
  assert.equal(h.calls.length, 0);
});

test("marketing consent only sets consent fields and is independent from checklist queueing", async () => {
  const h = handlerHarness(), res = response();
  await h.handler(req({ ...input, marketingConsent: true }), res);
  const rpc = h.calls.find(call => call[0] === "rpc")[2];
  assert.equal(res.statusCode, 201);
  assert.equal(rpc.p_marketing_consent, true);
  assert.equal(rpc.p_consent_recorded_at, "2026-10-25T10:00:00.000Z");
  assert.equal(rpc.p_idempotency_key.length, 64);
  assert.equal(res.body.checklist.status, "queued");
});

test("oversized request is rejected before rate limiting", async () => {
  const h = handlerHarness(), res = response();
  await h.handler(req(input, { headers: { "content-length": String(20 * 1024) } }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(h.rateKeys.length, 0);
});

test("Resend network failure is safely marked retryable without exposing errors", async () => {
  const oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.RESEND_FROM_EMAIL, oldError = console.error;
  process.env.RESEND_API_KEY = "unit-test-resend-secret";
  process.env.RESEND_FROM_EMAIL = "SiteLift Test <reports@example.com>";
  console.error = () => {};
  const rpcCalls = [];
  const job = { id: "job-1", lead_id: "lead-1", attempt_count: 1, claim_token: "00000000-0000-4000-8000-000000000001", idempotency_key: "safe-idempotency-key" };
  const db = {
    async rpc(name, args) {
      rpcCalls.push([name, args]);
      if (name === "claim_sitelift_delivery_job") return { data: [job], error: null };
      if (name === "finish_sitelift_delivery_job") return { data: true, error: null };
      throw new Error("unexpected rpc");
    },
    from(table) {
      assert.equal(table, "sitelift_leads");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: { id: "lead-1", email: "owner@example.com", business_name: "Example Shop", website_url: "https://example.com/", business_type: null }, error: null }; }
      };
    }
  };
  try {
    const result = await processChecklistDeliveryJob("job-1", {
      getSupabaseAdmin: () => db,
      fetchImpl: async () => { throw new Error("private URL and bearer secret should never be logged"); },
      now: () => new Date("2026-10-25T10:00:00.000Z")
    });
    assert.equal(result.status, "retryable");
    assert.equal(rpcCalls[1][1].p_status, "retryable");
    assert.equal(rpcCalls[1][1].p_error_code, "resend_network_error");
    assert.equal(rpcCalls[1][1].p_next_attempt_at, "2026-10-25T10:01:00.000Z");
  } finally {
    console.error = oldError;
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = oldFrom;
  }
});

test("worker sends the transactional checklist even when marketing consent is false", async () => {
  const oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_API_KEY = "unit-test-resend-secret";
  process.env.RESEND_FROM_EMAIL = "SiteLift Test <reports@example.com>";
  let sentPayload;
  const db = {
    async rpc(name) {
      if (name === "claim_sitelift_delivery_job") return { data: [{
        id: "job-1", lead_id: "lead-1", attempt_count: 1,
        claim_token: "00000000-0000-4000-8000-000000000001", idempotency_key: "safe-idempotency-key"
      }], error: null };
      return { data: true, error: null };
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: { id: "lead-1", email: "owner@example.com", business_name: null, website_url: "https://example.com/", business_type: null }, error: null }; }
      };
    }
  };
  try {
    const result = await processChecklistDeliveryJob("job-1", {
      getSupabaseAdmin: () => db,
      fetchImpl: async (_url, options) => {
        sentPayload = JSON.parse(options.body);
        return { ok: true, status: 200 };
      }
    });
    assert.equal(result.status, "sent");
    assert.deepEqual(sentPayload.to, ["owner@example.com"]);
    assert.match(sentPayload.text, /transactional email/);
  } finally {
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = oldFrom;
  }
});
