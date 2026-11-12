import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createResendLinkHandler } from "../api/paystack/resend-link.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const nowMs = Date.parse("2026-11-12T12:00:00.000Z");
const email = "customer@example.com";
const code = "a".repeat(64);
const hash = value => createHash("sha256").update(value).digest("hex");
const response = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } });
const payment = (overrides = {}) => ({
  id: "payment-1", audit_id: "audit-1", reference, customer_email: email,
  status: "paid", pdf_path: "audit-1/report.pdf", download_token_hash: "f".repeat(64),
  token_expires_at: "2026-10-21T12:00:00.000Z", token_redeemed_at: "2026-10-22T12:00:00.000Z",
  delivery_blocked: false, ...overrides
});
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

function harness({ initial = payment(), fetchImpl = async () => ({ ok: true, status: 200 }), tokens = [code] } = {}) {
  const state = structuredClone(initial), mutations = [], deliveries = [], rateLimitKeys = [];
  let tokenIndex = 0;
  const db = { from(table) {
    assert.equal(table, "audit_payments");
    return {
      select() {
        return { eq() { return this; }, maybeSingle: async () => ({ data: structuredClone(state), error: null }) };
      },
      update(values) {
        const filters = [];
        const builder = {
          eq(k, v) { filters.push([k, "eq", v]); return this; },
          is(k, v) { filters.push([k, "is", v]); return this; },
          select() { return this; },
          matches() {
            return filters.every(([k, op, v]) => op === "is" ? state[k] === null : state[k] === v);
          },
          async maybeSingle() {
            if (!this.matches()) return { data: null, error: null };
            Object.assign(state, values); mutations.push(structuredClone(values));
            return { data: { id: state.id }, error: null };
          },
          then(resolve, reject) {
            if (this.matches()) { Object.assign(state, values); mutations.push(structuredClone(values)); }
            return Promise.resolve({ error: null }).then(resolve, reject);
          }
        };
        return builder;
      }
    };
  } };
  const handler = createResendLinkHandler({
    getSupabaseAdmin: () => db,
    createRateLimiter: () => ({ limit: async key => { rateLimitKeys.push(key); return { success: true }; } }),
    fetchImpl: async (...args) => { deliveries.push(args); return fetchImpl(...args); },
    now: () => nowMs,
    createToken: () => tokens[Math.min(tokenIndex++, tokens.length - 1)]
  });
  return { handler, state, mutations, deliveries, rateLimitKeys };
}

test("missing Resend configuration returns 503 without rotating a recovery hash", async () => configured(async () => {
  const h = harness(), res = response();
  await h.handler(req(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.deliveries, []);
}, { key: "", from: "SiteLift Test <reports@example.com>" }));

test("unknown reference and mismatched email return identical generic responses without mutations", async () => configured(async () => {
  const a = harness(), ar = response(), b = harness(), br = response();
  await a.handler(req({ reference: "invalid-reference" }), ar);
  await b.handler(req({ email: "attacker@example.com" }), br);
  assert.equal(ar.statusCode, 200);
  assert.deepEqual(ar.body, br.body);
  assert.match(ar.body.message, /one-time recovery code/);
  for (const h of [a, b]) { assert.deepEqual(h.mutations, []); assert.deepEqual(h.deliveries, []); }
}));

test("paid report recovery rotates only a hash and emails the 256-bit code in the message body", async () => configured(async () => {
  const h = harness(), res = response();
  await h.handler(req({ email: " CUSTOMER@example.com " }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(h.deliveries.length, 1);
  const payload = JSON.parse(h.deliveries[0][1].body);
  assert.deepEqual(payload.to, [email]);
  assert.equal(payload.from, process.env.RESEND_FROM_EMAIL);
  assert.match(payload.text, new RegExp(code));
  const reportLink = payload.text.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(reportLink);
  const parsedLink = new URL(reportLink);
  assert.equal(parsedLink.searchParams.get("payment"), "recovery");
  assert.equal(parsedLink.searchParams.get("reference"), reference);
  assert.equal(parsedLink.searchParams.has("token"), false);
  assert.equal(parsedLink.searchParams.has("code"), false);
  assert.equal(h.state.download_token_hash, hash(code));
  assert.notEqual(h.state.download_token_hash, code);
  assert.equal(h.state.token_redeemed_at, null);
  assert.equal(Date.parse(h.state.token_expires_at), nowMs + 86400000);
  assert.match(res.body.message, /one-time recovery code/);
}));

test("delivery failure invalidates the newly rotated hash and never restores plaintext", async () => configured(async () => {
  const h = harness({ fetchImpl: async () => ({ ok: false, status: 502 }) });
  const res = response(), oldError = console.error;
  console.error = () => {};
  try { await h.handler(req(), res); } finally { console.error = oldError; }
  assert.equal(res.statusCode, 503);
  assert.equal(h.state.download_token_hash, null);
  assert.equal(h.state.token_expires_at, null);
  assert.equal(h.mutations.length, 2);
}));

test("concurrent recovery requests produce one hash rotation and one email", async () => configured(async () => {
  const h = harness({ tokens: [code, "b".repeat(64)] }), a = response(), b = response();
  await Promise.all([h.handler(req(), a), h.handler(req(), b)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.mutations.length, 1);
}));

test("rate limiter prefers platform client IP and ignores spoofed forwarding headers", async () => configured(async () => {
  const h = harness(), request = req(), res = response();
  request.headers["x-real-ip"] = "198.51.100.25";
  request.headers["x-forwarded-for"] = "203.0.113.10, 10.0.0.1";
  await h.handler(request, res);
  assert.deepEqual(h.rateLimitKeys, ["198.51.100.25"]);
}));
