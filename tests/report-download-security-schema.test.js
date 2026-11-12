import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrationPath = "../supabase/migrations/202611120001_sitelift_single_use_report_sessions.sql";

test("expand migration hashes legacy tokens before the later plaintext-column cleanup", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  const cleanup = await readFile(new URL("../supabase/migrations/202611120002_sitelift_remove_plaintext_download_tokens.sql", import.meta.url), "utf8");
  const hashStep = sql.indexOf("set download_token_hash = encode(digest(convert_to(download_token, 'UTF8'), 'sha256'), 'hex')");
  const indexStep = sql.indexOf("create unique index if not exists audit_payments_download_token_hash_uidx");
  assert.ok(hashStep >= 0 && indexStep > hashStep);
  assert.match(sql, /where download_token is not null\s+and download_token_hash is null/i);
  assert.doesNotMatch(sql, /download_token = null/i);
  const lateBackfill = cleanup.indexOf("set download_token_hash = encode(digest(convert_to(download_token, 'UTF8'), 'sha256'), 'hex')");
  const plaintextClear = cleanup.indexOf("set download_token = null");
  const columnDrop = cleanup.indexOf("drop column if exists download_token");
  assert.ok(lateBackfill >= 0 && plaintextClear > lateBackfill && columnDrop > plaintextClear);
  assert.match(cleanup, /set download_token = null/i);
  assert.match(cleanup, /drop column if exists download_token/i);
  assert.match(cleanup, /drop index if exists public\.audit_payments_download_token_uidx/i);
  assert.ok(sql.includes("created_at + interval '24 hours'"));
  assert.equal(createHash("sha256").update("legacy-secret").digest("hex").length, 64);
});
test("migration creates report-bound sessions with idle and absolute expiry enforcement", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.audit_download_sessions/i);
  assert.match(sql, /audit_payment_id uuid not null references public\.audit_payments/i);
  assert.match(sql, /audit_id uuid not null references public\.audits/i);
  assert.match(sql, /session_token_hash text not null unique/i);
  assert.match(sql, /session_expiry := p_now \+ interval '60 minutes'/i);
  assert.match(sql, /last_seen_at > p_now - interval '15 minutes'/i);
  assert.match(sql, /expires_at > p_now/i);
});

test("redemption is row-locked, paid-only, single-use, and blocked during delivery holds", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  assert.match(sql, /where ap\.reference = p_reference\s+for update/i);
  assert.match(sql, /payment_row\.status <> 'paid'/i);
  assert.match(sql, /payment_row\.delivery_blocked/i);
  assert.match(sql, /payment_row\.token_redeemed_at is not null/i);
  assert.match(sql, /set download_token_hash = null,\s+token_redeemed_at = p_now/i);
});

test("RPC execution is restricted to service_role and session records have RLS enabled", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  assert.match(sql, /alter table public\.audit_download_sessions enable row level security/i);
  assert.match(sql, /revoke all on public\.audit_download_sessions from anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.redeem_report_download\(text, text, text, timestamptz\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.redeem_report_download\(text, text, text, timestamptz\) to service_role/i);
  assert.match(sql, /grant execute on function public\.authorize_report_download\(uuid, text, timestamptz\) to service_role/i);
});

test("migration is additive and does not alter historical migrations or production data directly", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  assert.match(sql, /begin;/i);
  assert.match(sql, /commit;/i);
  assert.doesNotMatch(sql, /drop table|truncate\s/i);
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.match(sql, /delivery_blocked boolean not null default false/i);
});

test("application no longer reads or writes the legacy plaintext token column", async () => {
  const initialize = await readFile(new URL("../api/paystack/initialize.js", import.meta.url), "utf8");
  const recovery = await readFile(new URL("../api/paystack/resend-link.js", import.meta.url), "utf8");
  const redeem = await readFile(new URL("../api/paystack/redeem.js", import.meta.url), "utf8");
  const status = await readFile(new URL("../api/paystack/status.js", import.meta.url), "utf8");
  for (const source of [initialize, recovery, redeem, status]) {
    assert.doesNotMatch(source, /(?:select\([^\n]*download_token\s*[,)]|download_token\s*:)/i);
  }
  assert.match(initialize, /download_token_hash: sha256Hex\(downloadToken\)/);
  assert.match(recovery, /download_token_hash: sha256Hex\(recoveryCode\)/);
});
