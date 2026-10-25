-- Lead capture, durable checklist delivery, and CRM sync outbox.
-- Apply only to the dedicated SiteLift Supabase project after migration preflight.
create extension if not exists pgcrypto;

create table if not exists public.sitelift_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and length(email) <= 254),
  business_name text,
  website_url text not null,
  phone text,
  business_type text,
  audit_id uuid not null references public.audits(id) on delete restrict,
  source text not null,
  landing_page text,
  marketing_consent boolean not null default false,
  consent_recorded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sitelift_leads_consent_timestamp check (
    (marketing_consent = true and consent_recorded_at is not null)
    or (marketing_consent = false and consent_recorded_at is null)
  )
);

-- Partial index supports the explicitly consented marketing audience without
-- indexing non-consenting contacts into that particular lookup path.
create index if not exists sitelift_leads_email_website_consented_idx
  on public.sitelift_leads (email, website_url)
  where marketing_consent = true;
create index if not exists sitelift_leads_audit_id_idx
  on public.sitelift_leads (audit_id);

create table if not exists public.sitelift_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sitelift_leads(id) on delete cascade,
  job_type text not null default 'checklist_email' check (job_type = 'checklist_email'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'retryable', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  idempotency_key text not null unique,
  next_attempt_at timestamptz,
  last_error_code text,
  claimed_at timestamptz,
  claim_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sitelift_delivery_jobs_due_idx
  on public.sitelift_delivery_jobs (next_attempt_at, created_at)
  where status in ('pending', 'retryable');
create index if not exists sitelift_delivery_jobs_stale_claim_idx
  on public.sitelift_delivery_jobs (claimed_at)
  where status = 'processing';

create table if not exists public.sitelift_crm_sync (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sitelift_leads(id) on delete cascade,
  destination text not null default 'johnkay_client_engine',
  external_record_id text,
  status text not null default 'pending'
    check (status in ('pending', 'synced', 'retryable', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sitelift_crm_sync_lead_destination_unique unique (lead_id, destination)
);
create index if not exists sitelift_crm_sync_pending_idx
  on public.sitelift_crm_sync (created_at)
  where status in ('pending', 'retryable');

alter table public.sitelift_leads enable row level security;
alter table public.sitelift_delivery_jobs enable row level security;
alter table public.sitelift_crm_sync enable row level security;
revoke all on public.sitelift_leads from anon, authenticated;
revoke all on public.sitelift_delivery_jobs from anon, authenticated;
revoke all on public.sitelift_crm_sync from anon, authenticated;

-- Transactional persistence: the lead, delivery job, and CRM outbox row either
-- all commit or none do. Advisory locking serializes duplicate idempotency keys.
create or replace function public.capture_sitelift_lead(
  p_email text,
  p_business_name text,
  p_website_url text,
  p_phone text,
  p_business_type text,
  p_audit_id uuid,
  p_source text,
  p_landing_page text,
  p_marketing_consent boolean,
  p_consent_recorded_at timestamptz,
  p_idempotency_key text
)
returns table (lead_id uuid, delivery_job_id uuid, idempotent boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_job public.sitelift_delivery_jobs%rowtype;
  new_lead_id uuid;
  new_job_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 16 or length(p_idempotency_key) > 128 then
    raise exception using errcode = '22023', message = 'invalid_idempotency_key';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  select * into existing_job
    from public.sitelift_delivery_jobs
    where idempotency_key = p_idempotency_key;

  if found then
    if not exists (
      select 1 from public.sitelift_leads l
      where l.id = existing_job.lead_id
        and l.email = p_email
        and l.website_url = p_website_url
        and l.audit_id = p_audit_id
        and l.source = p_source
        and l.business_name is not distinct from p_business_name
        and l.phone is not distinct from p_phone
        and l.business_type is not distinct from p_business_type
        and l.landing_page is not distinct from p_landing_page
    ) then
      raise exception using errcode = '23505', message = 'idempotency_conflict';
    end if;
    return query select existing_job.lead_id, existing_job.id, true;
    return;
  end if;

  insert into public.sitelift_leads (
    email, business_name, website_url, phone, business_type, audit_id,
    source, landing_page, marketing_consent, consent_recorded_at
  ) values (
    p_email, p_business_name, p_website_url, p_phone, p_business_type, p_audit_id,
    p_source, p_landing_page, coalesce(p_marketing_consent, false),
    case when coalesce(p_marketing_consent, false) then p_consent_recorded_at else null end
  ) returning id into new_lead_id;

  insert into public.sitelift_delivery_jobs (lead_id, job_type, status, idempotency_key)
    values (new_lead_id, 'checklist_email', 'pending', p_idempotency_key)
    returning id into new_job_id;

  insert into public.sitelift_crm_sync (lead_id, destination, status)
    values (new_lead_id, 'johnkay_client_engine', 'pending')
    on conflict (lead_id, destination) do nothing;

  return query select new_lead_id, new_job_id, false;
end;
$$;

-- Claim one due job atomically. Stale worker leases are reclaimable after 10m.
create or replace function public.claim_sitelift_delivery_job(p_job_id uuid default null)
returns setof public.sitelift_delivery_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_id uuid;
begin
  update public.sitelift_delivery_jobs
    set status = 'failed',
        last_error_code = 'worker_lease_expired_max_attempts',
        claimed_at = null,
        claim_token = null,
        updated_at = now()
    where status = 'processing'
      and claimed_at < now() - interval '10 minutes'
      and attempt_count >= 5
      and (p_job_id is null or id = p_job_id);

  select j.id into candidate_id
    from public.sitelift_delivery_jobs j
    where (p_job_id is null or j.id = p_job_id)
      and j.attempt_count < 5
      and (
        (j.status in ('pending', 'retryable') and (j.next_attempt_at is null or j.next_attempt_at <= now()))
        or (j.status = 'processing' and j.claimed_at < now() - interval '10 minutes')
      )
    order by coalesce(j.next_attempt_at, j.created_at), j.created_at
    for update skip locked
    limit 1;

  if candidate_id is null then
    return;
  end if;

  return query
    update public.sitelift_delivery_jobs j
      set status = 'processing',
          attempt_count = j.attempt_count + 1,
          claimed_at = now(),
          claim_token = gen_random_uuid(),
          last_error_code = null,
          updated_at = now()
      where j.id = candidate_id
    returning j.*;
end;
$$;

-- A worker can finalize only the exact lease it claimed.
create or replace function public.finish_sitelift_delivery_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_next_attempt_at timestamptz,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  if p_status not in ('sent', 'retryable', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_delivery_status';
  end if;

  update public.sitelift_delivery_jobs
    set status = p_status,
        next_attempt_at = case when p_status = 'retryable' then p_next_attempt_at else null end,
        last_error_code = case when p_status = 'sent' then null else left(coalesce(p_error_code, 'delivery_failed'), 80) end,
        claimed_at = null,
        claim_token = null,
        updated_at = now()
    where id = p_job_id
      and status = 'processing'
      and claim_token = p_claim_token;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.capture_sitelift_lead(text,text,text,text,text,uuid,text,text,boolean,timestamptz,text) from public, anon, authenticated;
revoke all on function public.claim_sitelift_delivery_job(uuid) from public, anon, authenticated;
revoke all on function public.finish_sitelift_delivery_job(uuid,uuid,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.capture_sitelift_lead(text,text,text,text,text,uuid,text,text,boolean,timestamptz,text) to service_role;
grant execute on function public.claim_sitelift_delivery_job(uuid) to service_role;
grant execute on function public.finish_sitelift_delivery_job(uuid,uuid,text,timestamptz,text) to service_role;
