import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrationPath = "../supabase/migrations/202611120001_sitelift_single_use_report_sessions.sql";

test("forward-only migration hashes legacy tokens before clearing plaintext", async () => {
  const sql = await readFile(new URL(migrationPath, import.meta.url), "utf8");
  const hashStep = sql.indexOf("set download_token_hash = encode(digest(convert_to(download_token, 'UTF8'), 'sha256'), 'hex')");
  const clearStep = sql.indexOf("download_token = null", hashStep);
  const indexStep = sql.indexOf("create unique index if not exists audit_payments_download_token_hash_uidx");
  assert.ok(hashStep >= 0 && clearStep > hashStep && indexStep > clearStep);
  assert.match(sql, /where download_token is not null\s+and download_token_hash is null/i);
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
