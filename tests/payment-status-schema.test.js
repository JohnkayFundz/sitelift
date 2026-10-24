import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("payment status constraint preserves every status used by checkout and processing", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/202610220002_sitelift_payment_processing_claim.sql", import.meta.url),
    "utf8"
  );
  const initialMigration = await readFile(
    new URL("../supabase/migrations/202610170001_sitelift_audits_payments.sql", import.meta.url),
    "utf8"
  );
  const initialize = await readFile(
    new URL("../api/paystack/initialize.js", import.meta.url),
    "utf8"
  );
  const server = await readFile(
    new URL("../api/_lib/server.js", import.meta.url),
    "utf8"
  );

  const constraint = migration.match(
    /add constraint audit_payments_status_check\s+check \(status = any \(array\[([\s\S]*?)\]\)\)/
  );
  assert.ok(constraint, "processing migration must explicitly define the payment status constraint");

  const allowedStatuses = [...constraint[1].matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(allowedStatuses, [
    "initialization_failed",
    "initialization_unknown",
    "paid",
    "pending",
    "processing"
  ]);

  assert.match(initialMigration, /status text not null default 'pending' check \(status in \('pending','processing','initialization_unknown','initialization_failed','paid'\)\)/);
  assert.match(initialMigration, /where status in \('pending','processing','initialization_unknown'\)/);
  assert.match(initialize, /status: "initialization_unknown"/);
  assert.match(initialize, /status: "initialization_failed"/);
  assert.match(server, /status\.eq\.pending,status\.eq\.initialization_unknown,and\(status\.eq\.processing,processing_started_at\.lt\./);
  assert.match(server, /status: "paid"/);
});

test("forward-only production correction is repeatable and allows exactly the five payment states", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20261024140000_sitelift_payment_status_fix.sql", import.meta.url),
    "utf8"
  );

  assert.match(migration, /drop constraint if exists audit_payments_status_check/i);
  assert.match(migration, /add constraint audit_payments_status_check/i);

  const constraint = migration.match(
    /add constraint audit_payments_status_check\s+check \(status in \(([\s\S]*?)\)\)/i
  );
  assert.ok(constraint, "corrective migration must define the payment status constraint");

  const allowedStatuses = [...constraint[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(allowedStatuses, [
    "initialization_failed",
    "initialization_unknown",
    "paid",
    "pending",
    "processing"
  ]);

  assert.doesNotMatch(migration, /\b(insert|update|delete)\s+into?\b/i);
  assert.doesNotMatch(migration, /drop table|truncate\s/i);
});
