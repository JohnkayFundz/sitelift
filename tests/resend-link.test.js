import test from "node:test";
import assert from "node:assert/strict";
import { createResendLinkHandler } from "../api/paystack/resend-link.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const nowMs = Date.parse("2026-10-22T12:00:00.000Z");
const email = "customer@example.com";
const response = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } });
const payment = (overrides = {}) => ({ id: "payment-1", audit_id: "audit-1", reference, customer_email: email, status: "paid", pdf_path: "audit-1/report.pdf", download_token: "old-token", token_expires_at: "2026-10-21T12:00:00.000Z", ...overrides });
const req = (overrides = {}) => ({ method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, body: { reference, email, ...overrides } });

async function configured(run, { key = "test-resend-key", from = "SiteLift Test <reports@example.com>" } = {}) {
  const oldKey = process.env.RESEND_API_KEY, oldFrom = process.env.RESEND_FROM_EMAIL;
  if (!key) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key;
  if (!from) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = from;
  try { await run(); } finally {
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
    if (oldFrom === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = oldFrom;
  }
}

function harness({ initial = payment(), fetchImpl = async () => ({ ok: true, status: 200 }), tokens = ["fresh-token"] } = {}) {
  const state = structuredClone(initial), mutations = [], deliveries = [], rateLimitKeys = [];
  let tokenIndex = 0;
  const db = { from(table) {
    assert.equal(table, "audit_payments");
    return {
      select() { return { eq() { return this; }, maybeSingle: async () => ({ data: structuredClone(state), error: null }) }; },
      update(values) {
        const filters = [];
        const builder = {
          eq(k, v) { filters.push([k, v]); return this; },
          is(k, v) { filters.push([k, v]); return this; },
          select() { return this; },
          async maybeSingle() {
            if (!filters.every(([k, v]) => state[k] === v)) return { data: null, error: null };
            Object.assign(state, values); mutations.push(structuredClone(values));
            return { data: { id: state.id }, error: null };
          },
          then(resolve, reject) {
            if (filters.every(([k, v]) => state[k] === v)) { Object.assign(state, values); mutations.push(structuredClone(values)); }
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
        };
        return builder;
      }
    };
  } };
  const handler = createResendLinkHandler({
    getSupabaseAdmin: () => db,
    createRateLimiter: () => ({ limit: async (key) => { rateLimitKeys.push(key); return { success: true }; } }),
    fetchImpl: async (...args) => { deliveries.push(args); return fetchImpl(...args); },
    now: () => nowMs,
    createToken: () => tokens[Math.min(tokenIndex++, tokens.length - 1)]
  });
  return { handler, state, mutations, deliveries, rateLimitKeys };
}

test("missing Resend configuration returns 503 without rotating a token", async () => configured(async () => {
  const h = harness(), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /temporarily unavailable/i);
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.state.download_token, "old-token");
}, { key: "", from: "SiteLift Test <reports@example.com>" }));

test("unknown reference and mismatched email return identical generic responses without mutations", async () => configured(async () => {
  const a = harness(), ar = response(), b = harness(), br = response();
  await a.handler(req({ reference: "invalid-reference" }), ar);
  await b.handler(req({ email: "attacker@example.com" }), br);
  assert.equal(ar.statusCode, 200);
  assert.deepEqual(ar.body, br.body);
  assert.match(ar.body.message, /If the reference and email match a paid record/);
  for (const h of [a, b]) { assert.deepEqual(h.mutations, []); assert.deepEqual(h.deliveries, []); }
}));

test("unexpired token returns generic 200 without token rotation or email", async () => configured(async () => {
  const h = harness({ initial: payment({ token_expires_at: "2099-01-01T00:00:00.000Z" }) }), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.state.download_token, "old-token");
}));

test("expired paid token rotates for 24 hours and emails only the stored checkout address", async () => configured(async () => {
  const h = harness(), res = response();
  await h.handler(req({ email: " CUSTOMER@example.com " }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0][0], "https://api.resend.com/emails");
  const options = h.deliveries[0][1], payload = JSON.parse(options.body);
  assert.deepEqual(payload.to, [email]);
  assert.equal(payload.from, process.env.RESEND_FROM_EMAIL);
  assert.equal(options.headers.Authorization, "Bearer " + process.env.RESEND_API_KEY);
  assert.match(payload.text, /token=fresh-token/);
  assert.equal(h.state.download_token, "fresh-token");
  assert.equal(Date.parse(h.state.token_expires_at), nowMs + 86400000);
  assert.equal(h.mutations.length, 1);
  assert.match(res.body.message, /fresh download link has been sent/);
}));

test("email delivery failure conditionally rolls back token and expiry and returns 503", async () => configured(async () => {
  const expiry = "2026-10-21T12:00:00.000Z";
  const h = harness({ initial: payment({ token_expires_at: expiry }), fetchImpl: async () => ({ ok: false, status: 502 }) });
  const res = response(), oldError = console.error;
  console.error = () => {};
  try { await h.handler(req(), res); } finally { console.error = oldError; }
  assert.equal(res.statusCode, 503);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.state.download_token, "old-token");
  assert.equal(h.state.token_expires_at, expiry);
  assert.equal(h.mutations.length, 2);
  assert.deepEqual(h.mutations[1], { download_token: "old-token", token_expires_at: expiry });
}));

test("concurrent recovery requests produce one token rotation and exactly one email", async () => configured(async () => {
  const h = harness({ tokens: ["fresh-token-1", "fresh-token-2"] }), a = response(), b = response();
  await Promise.all([h.handler(req(), a), h.handler(req(), b)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.mutations.length, 1);
  assert.equal(h.state.download_token, "fresh-token-1");
}));


test("rate limiter uses the first X-Forwarded-For address", async () => configured(async () => {
  const h = harness(), request = req({ reference: "invalid-reference" }), res = response();
  request.headers["x-forwarded-for"] = "203.0.113.10, 10.0.0.1";
  await h.handler(request, res);
  assert.deepEqual(h.rateLimitKeys, ["203.0.113.10"]);
  assert.equal(res.statusCode, 200);
}));

test("rate limiter falls back to X-Real-IP when X-Forwarded-For is absent", async () => configured(async () => {
  const h = harness(), request = req({ reference: "invalid-reference" }), res = response();
  request.headers["x-real-ip"] = "198.51.100.25";
  await h.handler(request, res);
  assert.deepEqual(h.rateLimitKeys, ["198.51.100.25"]);
  assert.equal(res.statusCode, 200);
}));

test("rate limiter falls back to the socket remote address when proxy headers are absent", async () => configured(async () => {
  const h = harness(), request = req({ reference: "invalid-reference" }), res = response();
  request.socket.remoteAddress = "192.0.2.44";
  await h.handler(request, res);
  assert.deepEqual(h.rateLimitKeys, ["192.0.2.44"]);
  assert.equal(res.statusCode, 200);
}));
