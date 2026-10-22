import test from "node:test";
import assert from "node:assert/strict";
import { createResendLinkHandler } from "../api/paystack/resend-link.js";

const reference = "sitelift_decb676a-e5fb-40eb-9ea6-e983b2a4840b_c2ad7387235540f0b4eacd86bcfb87b9";
const nowMs = Date.parse("2026-10-22T12:00:00.000Z");
const checkoutEmail = "customer@example.com";

function makeResponse() {
  return {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

function makePayment(overrides = {}) {
  return {
    id: "payment-1",
    audit_id: "audit-1",
    reference,
    customer_email: checkoutEmail,
    status: "paid",
    pdf_path: "audit-1/report.pdf",
    download_token: "old-token",
    token_expires_at: "2026-10-21T12:00:00.000Z",
    ...overrides
  };
}

function harness({ payment = makePayment(), fetchImpl = async () => ({ ok: true, status: 200 }), tokens = ["fresh-token"] } = {}) {
  const state = structuredClone(payment);
  const mutations = [];
  const deliveries = [];
  let tokenIndex = 0;

  const db = {
    from(table) {
      assert.equal(table, "audit_payments");
      return {
        select() {
          return {
            eq() { return this; },
            maybeSingle: async () => ({ data: structuredClone(state), error: null })
          };
        },
        update(values) {
          const filters = [];
          const builder = {
            eq(column, value) { filters.push([column, value]); return this; },
            is(column, value) { filters.push([column, value]); return this; },
            select() { this.returnRows = true; return this; },
            async maybeSingle() {
              const matches = filters.every(([column, value]) => state[column] === value);
              if (!matches) return { data: null, error: null };
              Object.assign(state, values);
              mutations.push(structuredClone(values));
              return { data: { id: state.id }, error: null };
            },
            then(resolve, reject) {
              const matches = filters.every(([column, value]) => state[column] === value);
              if (matches) {
                Object.assign(state, values);
                mutations.push(structuredClone(values));
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            }
          };
          return builder;
        }
      };
    }
  };

  const handler = createResendLinkHandler({
    getSupabaseAdmin: () => db,
    createRateLimiter: () => ({ limit: async () => ({ success: true }) }),
    fetchImpl: async (...args) => {
      deliveries.push(args);
      return fetchImpl(...args);
    },
    now: () => nowMs,
    createToken: () => tokens[Math.min(tokenIndex++, tokens.length - 1)]
  });

  return { handler, state, mutations, deliveries };
}

function request(overrides = {}) {
  return {
    method: "POST",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    body: { reference, email: checkoutEmail, ...overrides }
  };
}

async function withMailConfig(run, { key = "test-resend-key", from = "SiteLift Test <reports@example.com>" } = {}) {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  if (key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = key;
  if (from === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = from;
  try { await run(); }
  finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = previousFrom;
  }
}

test("missing Resend configuration returns 503 before database access or token rotation", async () => {
  await withMailConfig(async () => {
    const { handler, state, mutations, deliveries } = harness();
    const response = makeResponse();
    await handler(request(), response);
    assert.equal(response.statusCode, 503);
    assert.match(response.body.error, /temporarily unavailable/i);
    assert.deepEqual(mutations, []);
    assert.deepEqual(deliveries, []);
    assert.equal(state.download_token, "old-token");
  }, { key: undefined, from: "SiteLift Test <reports@example.com>" });
});

test("unknown reference and mismatched checkout email return the same generic response without mutations", async () => {
  await withMailConfig(async () => {
    const unknown = harness();
    const unknownResponse = makeResponse();
    await unknown.handler(request({ reference: "invalid-reference" }), unknownResponse);

    const mismatch = harness();
    const mismatchResponse = makeResponse();
    await mismatch.handler(request({ email: "attacker@example.com" }), mismatchResponse);

    assert.equal(unknownResponse.statusCode, 200);
    assert.deepEqual(unknownResponse.body, mismatchResponse.body);
    assert.match(unknownResponse.body.message, /If the reference and email match a paid record/);
    assert.deepEqual(unknown.mutations, []);
    assert.deepEqual(mismatch.mutations, []);
    assert.deepEqual(unknown.deliveries, []);
    assert.deepEqual(mismatch.deliveries, []);
  });
});

test("unexpired token returns generic 200 and does not rotate or send email", async () => {
  await withMailConfig(async () => {
    const { handler, state, mutations, deliveries } = harness({
      payment: makePayment({ token_expires_at: "2099-01-01T00:00:00.000Z" })
    });
    const response = makeResponse();
    await handler(request(), response);
    assert.equal(response.statusCode, 200);
    assert.match(response.body.message, /fresh download link has been sent/);
    assert.deepEqual(mutations, []);
    assert.deepEqual(deliveries, []);
    assert.equal(state.download_token, "old-token");
  });
});

test("expired paid token rotates for 24 hours and emails only the stored checkout address", async () => {
  await withMailConfig(async () => {
    const { handler, state, mutations, deliveries } = harness();
    const response = makeResponse();
    await handler(request({ email: " CUSTOMER@example.com " }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0][0], "https://api.resend.com/emails");
    const options = deliveries[0][1];
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.to, [checkoutEmail]);
    assert.equal(payload.from, process.env.RESEND_FROM_EMAIL);
    assert.equal(options.headers.Authorization, "Bearer " + process.env.RESEND_API_KEY);
    assert.match(payload.text, /token=fresh-token/);
    assert.equal(state.download_token, "fresh-token");
    assert.equal(Date.parse(state.token_expires_at), nowMs + 24 * 60 * 60 * 1000);
    assert.equal(mutations.length, 1);
    assert.deepEqual(response.body, { message: "If the reference and email match a paid record, a fresh download link has been sent to your email." });
  });
});

test("email delivery failure rolls back the previous token and expiry and returns 503", async () => {
  await withMailConfig(async () => {
    const originalExpiry = "2026-10-21T12:00:00.000Z";
    const { handler, state, mutations, deliveries } = harness({
      payment: makePayment({ token_expires_at: originalExpiry }),
      fetchImpl: async () => ({ ok: false, status: 502 })
    });
    const response = makeResponse();
    const originalError = console.error;
    console.error = () => {};
    try { await handler(request(), response); }
    finally { console.error = originalError; }

    assert.equal(response.statusCode, 503);
    assert.equal(deliveries.length, 1);
    assert.equal(state.download_token, "old-token");
    assert.equal(state.token_expires_at, originalExpiry);
    assert.equal(mutations.length, 2, "one rotation and one conditional rollback");
    assert.deepEqual(mutations[1], { download_token: "old-token", token_expires_at: originalExpiry });
  });
});

test("concurrent recovery requests produce one token rotation and exactly one email", async () => {
  await withMailConfig(async () => {
    const { handler, state, mutations, deliveries } = harness({ tokens: ["fresh-token-1", "fresh-token-2"] });
    const firstResponse = makeResponse();
    const secondResponse = makeResponse();
    await Promise.all([
      handler(request(), firstResponse),
      handler(request(), secondResponse)
    ]);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(mutations.length, 1);
    assert.equal(state.download_token, "fresh-token-1");
  });
});
