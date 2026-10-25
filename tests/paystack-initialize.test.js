import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPaystackInitializeHandler } from "../api/paystack/initialize.js";

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

test("checkout initialization rate limit rejects excess attempts before database or Paystack calls", async () => {
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  let databaseCalls = 0;
  let providerCalls = 0;
  let limitedIp = null;
  const handler = createPaystackInitializeHandler({
    createRateLimiter: () => ({
      limit: async (ip) => {
        limitedIp = ip;
        return { success: false };
      }
    }),
    getSupabaseAdmin: () => {
      databaseCalls += 1;
      throw new Error("Rate-limited request must not access the database");
    },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Rate-limited request must not call Paystack");
    }
  });
  const res = response();
  try {
    await handler({
      method: "POST",
      headers: { "x-real-ip": "203.0.113.10" },
      socket: { remoteAddress: "127.0.0.1" },
      body: { auditId: "decb676a-e5fb-40eb-9ea6-e983b2a4840b", email: "customer@example.com" }
    }, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["Retry-After"], "600");
    assert.equal(limitedIp, "203.0.113.10");
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousSecret;
  }
});

test("checkout initialization rejects an existing active payment before calling Paystack", async () => {
  const previousSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "unit-test-paystack-secret";
  let providerCalls = 0;
  const activePaymentQuery = {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    limit() { return this; },
    async maybeSingle() { return { data: { id: "existing-payment" }, error: null }; }
  };
  const db = {
    from(table) {
      assert.equal(table, "audits");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: { id: "decb676a-e5fb-40eb-9ea6-e983b2a4840b" }, error: null }; }
      };
    }
  };
  const originalFrom = db.from;
  db.from = (table) => {
    if (table === "audits") return originalFrom(table);
    assert.equal(table, "audit_payments");
    return activePaymentQuery;
  };
  const handler = createPaystackInitializeHandler({
    createRateLimiter: () => ({ limit: async () => ({ success: true }) }),
    getSupabaseAdmin: () => db,
    fetchImpl: async () => { providerCalls += 1; throw new Error("Must not call Paystack"); }
  });
  const res = response();
  try {
    await handler({
      method: "POST",
      headers: { "x-real-ip": "203.0.113.10" },
      body: { auditId: "decb676a-e5fb-40eb-9ea6-e983b2a4840b", email: "customer@example.com" }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(providerCalls, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousSecret;
  }
});

test("checkout initialization locks an unknown provider outcome and tells retries to reconcile", async () => {
  const source = await readFile(new URL("../api/paystack/initialize.js", import.meta.url), "utf8");
  assert.match(source, /status: "initialization_unknown"/);
  assert.match(source, /Checkout status is uncertain\. Please contact support before retrying/);
  assert.match(source, /status === "initialization_unknown"/);
  const migration = await readFile(new URL("../supabase/migrations/20261019173629_sitelift_audits_payments.sql", import.meta.url), "utf8");
  assert.match(migration, /'initialization_unknown'/);
  assert.match(migration, /where status in \('pending','processing','initialization_unknown'\)/);
});

test("checkout initialization uses a shared five-attempt sliding window and fails closed without configuration", async () => {
  const source = await readFile(new URL("../api/paystack/initialize.js", import.meta.url), "utf8");
  assert.match(source, /Ratelimit\.slidingWindow\(5, "10 m"\)/);
  assert.match(source, /prefix: "sitelift:paystack-initialize"/);
  assert.match(source, /Payment initialization rate limiter is not configured/);
});

test("payment migration enforces a single pending or processing checkout per audit", async () => {
  const indexMigration = await readFile(new URL("../supabase/migrations/202610250001_sitelift_active_checkout_unique_index.sql", import.meta.url), "utf8");
  assert.match(indexMigration, /create unique index if not exists audit_payments_one_active_checkout_per_audit_idx/);
  assert.match(indexMigration, /on public\\.audit_payments \\(audit_id\\) where status in \\('pending', 'processing', 'initialization_unknown'\\)/);
});

test("Vercel config defines exactly one CSP policy and permits Paystack checkout form submission", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const policies = config.headers.flatMap((entry) => entry.headers)
    .filter((header) => header.key.toLowerCase() === "content-security-policy");
  assert.equal(policies.length, 1);
  assert.match(policies[0].value, /form-action 'self' https:\/\/checkout\.paystack\.com/);
});
