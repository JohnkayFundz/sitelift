import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryCronHandler } from "../api/cron/deliver-checklists.js";

function response() {
  return {
    statusCode: null, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

async function withSecret(value, run) {
  const old = process.env.CRON_SECRET;
  if (value === null) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try { await run(); }
  finally {
    if (old === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = old;
  }
}

test("delivery cron fails closed when CRON_SECRET is not configured", async () => withSecret(null, async () => {
  let calls = 0;
  const handler = createDeliveryCronHandler({ processJobs: async () => { calls += 1; return []; } });
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer anything" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
}));

test("delivery cron rejects missing or incorrect bearer credentials", async () => withSecret("expected-test-secret", async () => {
  let calls = 0;
  const handler = createDeliveryCronHandler({ processJobs: async () => { calls += 1; return []; } });
  for (const authorization of [undefined, "Bearer wrong-secret"]) {
    const res = response();
    await handler({ method: "GET", headers: { authorization } }, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(calls, 0);
}));

test("delivery cron processes a bounded batch and returns status counts", async () => withSecret("expected-test-secret", async () => {
  let options;
  const handler = createDeliveryCronHandler({
    processJobs: async value => {
      options = value;
      return [{ status: "sent" }, { status: "retryable" }, { status: "failed" }];
    }
  });
  const res = response();
  await handler({ method: "GET", headers: { authorization: "Bearer expected-test-secret" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(options.limit, 3);
  assert.deepEqual(res.body, {
    success: true, processed: 3, summary: { sent: 1, retryable: 1, failed: 1 }
  });
}));

test("delivery cron allows only GET and POST", async () => withSecret("expected-test-secret", async () => {
  const handler = createDeliveryCronHandler({ processJobs: async () => [] });
  const res = response();
  await handler({ method: "PUT", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
}));
