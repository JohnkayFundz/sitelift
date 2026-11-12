-- Forward-only security migration for single-use report redemption and sessions.
-- Authored on the Phase 1 branch only. Do not apply until the coordinated API
-- and frontend deployment is ready and staging application is separately authorized.

begin;

alter table public.audit_payments
  add column if not exists download_token_hash text,
  add column if not exists token_redeemed_at timestamptz,
  add column if not exists delivery_blocked boolean not null default false,
  add column if not exists delivery_block_reason text,
  add column if not exists delivery_blocked_at timestamptz;

-- Expand phase: backfill hashes without deleting the legacy column yet. This
-- permits a controlled application cutover while the old application version
-- may still be serving requests. The follow-up contract migration removes the
-- plaintext column only after the new application is deployed.
update public.audit_payments
set download_token_hash = encode(digest(convert_to(download_token, 'UTF8'), 'sha256'), 'hex')
where download_token is not null
  and download_token_hash is null;

create unique index if not exists audit_payments_download_token_hash_uidx
  on public.audit_payments (download_token_hash)
  where download_token_hash is not null;

alter table public.audit_payments
  drop constraint if exists audit_payments_download_token_hash_format_check;

alter table public.audit_payments
  add constraint audit_payments_download_token_hash_format_check
  check (download_token_hash is null or download_token_hash ~ '^[0-9a-f]{64}$');

create table if not exists public.audit_download_sessions (
  id uuid primary key default gen_random_uuid(),
  audit_payment_id uuid not null references public.audit_payments(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete restrict,
  session_token_hash text not null unique
    check (session_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint audit_download_sessions_expiry_check check (expires_at > created_at)
);

create index if not exists audit_download_sessions_payment_idx
  on public.audit_download_sessions (audit_payment_id, created_at desc);

create index if not exists audit_download_sessions_audit_idx
  on public.audit_download_sessions (audit_id, expires_at);

alter table public.audit_download_sessions enable row level security;
revoke all on public.audit_download_sessions from anon, authenticated;

-- The caller supplies SHA-256 hex digests only. The function locks the payment
-- row so simultaneous redemptions cannot both succeed. Raw secrets never enter
-- PostgreSQL, logs, or function results.
create or replace function public.redeem_report_download(
  p_reference text,
  p_token_hash text,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, session_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  payment_row public.audit_payments%rowtype;
  session_expiry timestamptz;
begin
  if p_reference is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}
    return;
  end if;

  select ap.* into payment_row
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked
    or payment_row.download_token_hash is distinct from p_token_hash
    or payment_row.token_expires_at is null
    or payment_row.token_expires_at <= p_now
    or payment_row.token_redeemed_at is not null then
    return;
  end if;

  session_expiry := p_now + interval '60 minutes';

  insert into public.audit_download_sessions (
    audit_payment_id, audit_id, session_token_hash,
    created_at, last_seen_at, expires_at
  ) values (
    payment_row.id, payment_row.audit_id, p_session_hash,
    p_now, p_now, session_expiry
  );

  update public.audit_payments
  set download_token_hash = null,
      token_redeemed_at = p_now
  where id = payment_row.id;

  return query select payment_row.audit_id, session_expiry;
end;
$$;

-- Every download rechecks entitlement and delivery-block state. Idle expiry is
-- 15 minutes; absolute expiry is 60 minutes from session creation.
create or replace function public.authorize_report_download(
  p_audit_id uuid,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, pdf_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  session_row public.audit_download_sessions%rowtype;
  payment_row public.audit_payments%rowtype;
begin
  if p_audit_id is null
    or p_session_hash is null
    or p_session_hash !~ '^[0-9a-f]{64}
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;

    or p_session_hash is null
    or p_session_hash !~ '^[0-9a-f]{64}
    return;
  end if;

  select ap.* into payment_row
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked
    or payment_row.download_token_hash is distinct from p_token_hash
    or payment_row.token_expires_at is null
    or payment_row.token_expires_at <= p_now
    or payment_row.token_redeemed_at is not null then
    return;
  end if;

  session_expiry := p_now + interval '60 minutes';

  insert into public.audit_download_sessions (
    audit_payment_id, audit_id, session_token_hash,
    created_at, last_seen_at, expires_at
  ) values (
    payment_row.id, payment_row.audit_id, p_session_hash,
    p_now, p_now, session_expiry
  );

  update public.audit_payments
  set download_token_hash = null,
      token_redeemed_at = p_now
  where id = payment_row.id;

  return query select payment_row.audit_id, session_expiry;
end;
$$;

-- Every download rechecks entitlement and delivery-block state. Idle expiry is
-- 15 minutes; absolute expiry is 60 minutes from session creation.
create or replace function public.authorize_report_download(
  p_audit_id uuid,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, pdf_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  session_row public.audit_download_sessions%rowtype;
  payment_row public.audit_payments%rowtype;
begin
  if p_audit_id is null
    or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_now is null then
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;

    or p_now is null then
    return;
  end if;

  select ap.* into payment_row
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked
    or payment_row.download_token_hash is distinct from p_token_hash
    or payment_row.token_expires_at is null
    or payment_row.token_expires_at <= p_now
    or payment_row.token_redeemed_at is not null then
    return;
  end if;

  session_expiry := p_now + interval '60 minutes';

  insert into public.audit_download_sessions (
    audit_payment_id, audit_id, session_token_hash,
    created_at, last_seen_at, expires_at
  ) values (
    payment_row.id, payment_row.audit_id, p_session_hash,
    p_now, p_now, session_expiry
  );

  update public.audit_payments
  set download_token_hash = null,
      token_redeemed_at = p_now
  where id = payment_row.id;

  return query select payment_row.audit_id, session_expiry;
end;
$$;

-- Every download rechecks entitlement and delivery-block state. Idle expiry is
-- 15 minutes; absolute expiry is 60 minutes from session creation.
create or replace function public.authorize_report_download(
  p_audit_id uuid,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, pdf_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  session_row public.audit_download_sessions%rowtype;
  payment_row public.audit_payments%rowtype;
begin
  if p_audit_id is null
    or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_now is null then
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;

    or p_now is null then
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;

    or p_session_hash is null
    or p_session_hash !~ '^[0-9a-f]{64}
    return;
  end if;

  select ap.* into payment_row
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked
    or payment_row.download_token_hash is distinct from p_token_hash
    or payment_row.token_expires_at is null
    or payment_row.token_expires_at <= p_now
    or payment_row.token_redeemed_at is not null then
    return;
  end if;

  session_expiry := p_now + interval '60 minutes';

  insert into public.audit_download_sessions (
    audit_payment_id, audit_id, session_token_hash,
    created_at, last_seen_at, expires_at
  ) values (
    payment_row.id, payment_row.audit_id, p_session_hash,
    p_now, p_now, session_expiry
  );

  update public.audit_payments
  set download_token_hash = null,
      token_redeemed_at = p_now
  where id = payment_row.id;

  return query select payment_row.audit_id, session_expiry;
end;
$$;

-- Every download rechecks entitlement and delivery-block state. Idle expiry is
-- 15 minutes; absolute expiry is 60 minutes from session creation.
create or replace function public.authorize_report_download(
  p_audit_id uuid,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, pdf_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  session_row public.audit_download_sessions%rowtype;
  payment_row public.audit_payments%rowtype;
begin
  if p_audit_id is null
    or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_now is null then
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;

    or p_now is null then
    return;
  end if;

  select ap.* into payment_row
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked
    or payment_row.download_token_hash is distinct from p_token_hash
    or payment_row.token_expires_at is null
    or payment_row.token_expires_at <= p_now
    or payment_row.token_redeemed_at is not null then
    return;
  end if;

  session_expiry := p_now + interval '60 minutes';

  insert into public.audit_download_sessions (
    audit_payment_id, audit_id, session_token_hash,
    created_at, last_seen_at, expires_at
  ) values (
    payment_row.id, payment_row.audit_id, p_session_hash,
    p_now, p_now, session_expiry
  );

  update public.audit_payments
  set download_token_hash = null,
      token_redeemed_at = p_now
  where id = payment_row.id;

  return query select payment_row.audit_id, session_expiry;
end;
$$;

-- Every download rechecks entitlement and delivery-block state. Idle expiry is
-- 15 minutes; absolute expiry is 60 minutes from session creation.
create or replace function public.authorize_report_download(
  p_audit_id uuid,
  p_session_hash text,
  p_now timestamptz default now()
)
returns table (audit_id uuid, pdf_path text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  session_row public.audit_download_sessions%rowtype;
  payment_row public.audit_payments%rowtype;
begin
  if p_audit_id is null
    or p_session_hash !~ '^[0-9a-f]{64}$'
    or p_now is null then
    return;
  end if;

  select s.* into session_row
  from public.audit_download_sessions s
  where s.audit_id = p_audit_id
    and s.session_token_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > p_now
    and s.last_seen_at > p_now - interval '15 minutes'
  for update;

  if not found then
    return;
  end if;

  select p.* into payment_row
  from public.audit_payments p
  where p.id = session_row.audit_payment_id
    and p.audit_id = p_audit_id
  for update;

  if not found
    or payment_row.status <> 'paid'
    or payment_row.pdf_path is null
    or payment_row.delivery_blocked then
    return;
  end if;

  update public.audit_download_sessions
  set last_seen_at = p_now
  where id = session_row.id;

  return query select payment_row.audit_id, payment_row.pdf_path;
end;
$$;

revoke all on function public.redeem_report_download(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.authorize_report_download(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.redeem_report_download(text, text, text, timestamptz) to service_role;
grant execute on function public.authorize_report_download(uuid, text, timestamptz) to service_role;

commit;
