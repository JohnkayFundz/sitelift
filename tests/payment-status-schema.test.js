import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("historical migrations preserve recorded production payment states and later correction", async () => {
  const initialMigration = await readFile(
    new URL("../supabase/migrations/20261019173629_sitelift_audits_payments.sql", import.meta.url),
    "utf8"
  );
  const processingMigration = await readFile(
    new URL("../supabase/migrations/20261022044046_sitelift_payment_processing_claim.sql", import.meta.url),
    "utf8"
  );
  const correction = await readFile(
    new URL("../supabase/migrations/20261024141053_sitelift_payment_status_fix.sql", import.meta.url),
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

  assert.match(initialMigration, /status text not null default 'pending' check \(status in \('pending','initialization_failed','paid'\)\)/);
  assert.match(processingMigration, /'pending'::text, 'processing'::text, 'initialization_failed'::text, 'paid'::text/);
  assert.doesNotMatch(processingMigration, /initialization_unknown/);

  const constraint = correction.match(
    /add constraint audit_payments_status_check\s+check \(status in \(([\s\S]*?)\)\)/i
  );
  assert.ok(constraint, "later correction must define the final payment status constraint");
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

  assert.match(initialize, /status: "initialization_unknown"/);
  assert.match(initialize, /status: "initialization_failed"/);
  assert.match(server, /status\.eq\.pending,status\.eq\.initialization_unknown,and\(status\.eq\.processing,processing_started_at\.lt\./);
  assert.match(server, /status: "paid"/);
});

test("forward-only active checkout index is separate from historical migrations", async () => {
  const initialMigration = await readFile(
    new URL("../supabase/migrations/20261019173629_sitelift_audits_payments.sql", import.meta.url),
    "utf8"
  );
  const migration = await readFile(
    new URL("../supabase/migrations/202610250001_sitelift_active_checkout_unique_index.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(initialMigration, /audit_payments_one_active_checkout_per_audit_idx/);
  assert.match(migration, /create unique index if not exists audit_payments_one_active_checkout_per_audit_idx/);
  assert.match(migration, /where status in \('pending', 'processing', 'initialization_unknown'\)/);
  assert.match(migration, /having count\(\*\) > 1/);
});

test("forward-only production correction is repeatable and allows exactly the five payment states", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20261024141053_sitelift_payment_status_fix.sql", import.meta.url),
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
