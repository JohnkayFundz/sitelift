import test from "node:test";
import assert from "node:assert/strict";
import { processCrmSyncJob } from "../api/_lib/crm-sync.js";
import { createCrmSyncCronHandler } from "../api/cron/sync-crm.js";

function response() {
  return {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

async function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try { await run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function workerDb({ job = {}, lead = {}, claimError = null } = {}) {
  const rpcCalls = [];
  const calls = {
    rpcCalls,
    db: {
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        if (name === "claim_sitelift_crm_sync") {
          if (claimError) return { data: null, error: claimError };
          return { data: [{ ...{
            id: "outbox-1", lead_id: "lead-1", attempt_count: 1,
            claim_token: "00000000-0000-4000-8000-000000000001"
          }, ...job }], error: null };
        }
        if (name === "finish_sitelift_crm_sync") return { data: true, error: null };
        throw new Error("unexpected rpc");
      },
      from(table) {
        assert.equal(table, "sitelift_leads");
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: { id: "lead-1", email: "owner@example.com", business_name: "Example Shop",
              website_url: "https://example.com/", business_type: "retail", audit_id: "audit-1",
              source: "mobile-speed-lagos", ...lead }, error: null };
          }
        };
      }
    }
  };
  return calls;
}

const configured = {
  CRM_API_URL: "https://crm.example.test/api/integrations/sitelift",
  CRM_API_KEY: "unit-test-crm-key",
  CRON_SECRET: "unit-test-cron-secret"
};

test("CRM cron fails closed when CRON_SECRET is missing", async () => withEnv({ CRON_SECRET: null }, async () => {
  let processed = 0;
  const handler = createCrmSyncCronHandler({ processJobs: async () => { processed += 1; return []; } });
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer anything" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(processed, 0);
}));

test("CRM cron rejects missing and invalid bearer credentials", async () => withEnv(configured, async () => {
  let processed = 0;
  const handler = createCrmSyncCronHandler({ processJobs: async () => { processed += 1; return []; } });
  for (const authorization of [undefined, "Bearer wrong-secret"]) {
    const res = response();
    await handler({ method: "GET", headers: { authorization } }, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(processed, 0);
}));

test("successful outbox delivery sends the mapped payload and finalizes as synced", async () => withEnv(configured, async () => {
  const h = workerDb();
  let sent;
  const result = await processCrmSyncJob(null, {
    getSupabaseAdmin: () => h.db,
    fetchImpl: async (url, options) => {
      assert.equal(url, configured.CRM_API_URL);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.headers.Authorization, "Bearer " + configured.CRM_API_KEY);
      sent = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ id: "bizboard-record-7" }) };
    },
    now: () => new Date("2026-10-25T10:00:00.000Z")
  });
  assert.equal(result.status, "synced");
  assert.deepEqual(sent, {
    source: "sitelift",
    idempotencyKey: "outbox-1",
    lead: {
      email: "owner@example.com", businessName: "Example Shop",
      websiteUrl: "https://example.com/", businessType: "retail"
    },
    audit: { id: "audit-1" },
    acquisitionSource: "mobile-speed-lagos"
  });
  const finish = h.rpcCalls.find(call => call.name === "finish_sitelift_crm_sync");
  assert.equal(finish.args.p_status, "synced");
  assert.equal(finish.args.p_external_record_id, "bizboard-record-7");
  assert.equal(finish.args.p_error_code, null);
}));

test("transient API failure is retryable with safe code and exponential backoff", async () => withEnv(configured, async () => {
  const h = workerDb();
  const oldError = console.error;
  console.error = () => {};
  try {
    const result = await processCrmSyncJob(null, {
      getSupabaseAdmin: () => h.db,
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ secret: "must not be persisted" }) }),
      now: () => new Date("2026-10-25T10:00:00.000Z")
    });
    assert.equal(result.status, "retryable");
    const finish = h.rpcCalls.find(call => call.name === "finish_sitelift_crm_sync");
    assert.equal(finish.args.p_status, "retryable");
    assert.equal(finish.args.p_error_code, "crm_rate_limited");
    assert.equal(finish.args.p_next_attempt_at, "2026-10-25T10:01:00.000Z");
    assert.doesNotMatch(JSON.stringify(finish.args), /must not be persisted|unit-test-crm-key/);
  } finally { console.error = oldError; }
}));

test("fifth failed attempt becomes failed and does not schedule another retry", async () => withEnv(configured, async () => {
  const h = workerDb({ job: { attempt_count: 5 } });
  const result = await processCrmSyncJob(null, {
    getSupabaseAdmin: () => h.db,
    fetchImpl: async () => { throw new Error("secret endpoint and credentials must not leak"); },
    now: () => new Date("2026-10-25T10:00:00.000Z")
  });
  assert.equal(result.status, "failed");
  const finish = h.rpcCalls.find(call => call.name === "finish_sitelift_crm_sync");
  assert.equal(finish.args.p_status, "failed");
  assert.equal(finish.args.p_error_code, "crm_network_error");
  assert.equal(finish.args.p_next_attempt_at, null);
  assert.doesNotMatch(JSON.stringify(finish.args), /secret endpoint|credentials/);
}));

test("CRM cron processes a bounded batch and reports aggregate statuses only", async () => withEnv(configured, async () => {
  let options;
  const handler = createCrmSyncCronHandler({ processJobs: async value => {
    options = value;
    return [{ status: "synced" }, { status: "retryable" }, { status: "failed" }];
  } });
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer " + configured.CRON_SECRET } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(options.limit, 3);
  assert.deepEqual(res.body, { success: true, processed: 3,
    summary: { synced: 1, retryable: 1, failed: 1 } });
}));
