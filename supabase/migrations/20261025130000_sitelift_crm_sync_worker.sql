-- CRM outbox worker support. Review migration history before applying to any database.
-- This file is intentionally committed only; it is not executed by CI or this change.
alter table public.sitelift_crm_sync
  drop constraint if exists sitelift_crm_sync_status_check;

alter table public.sitelift_crm_sync
  add constraint sitelift_crm_sync_status_check
  check (status in ('pending', 'processing', 'synced', 'retryable', 'failed'));

alter table public.sitelift_crm_sync
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid;

create index if not exists sitelift_crm_sync_due_idx
  on public.sitelift_crm_sync (next_attempt_at, created_at)
  where status in ('pending', 'retryable');

create index if not exists sitelift_crm_sync_stale_claim_idx
  on public.sitelift_crm_sync (claimed_at)
  where status = 'processing';

-- Claims one due row with SKIP LOCKED and a unique lease token. A stale claim can
-- be recovered after 10 minutes; attempt_count is incremented when claimed.
create or replace function public.claim_sitelift_crm_sync(p_job_id uuid default null)
returns setof public.sitelift_crm_sync
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_id uuid;
begin
  update public.sitelift_crm_sync
    set status = 'failed',
        last_error_code = 'crm_worker_lease_expired_max_attempts',
        claimed_at = null,
        claim_token = null,
        updated_at = now()
    where status = 'processing'
      and claimed_at < now() - interval '10 minutes'
      and attempt_count >= 5
      and (p_job_id is null or id = p_job_id);

  select j.id into candidate_id
    from public.sitelift_crm_sync j
    where (p_job_id is null or j.id = p_job_id)
      and j.attempt_count < 5
      and (
        (j.status in ('pending', 'retryable')
          and (j.next_attempt_at is null or j.next_attempt_at <= now()))
        or (j.status = 'processing' and j.claimed_at < now() - interval '10 minutes')
      )
    order by coalesce(j.next_attempt_at, j.created_at), j.created_at
    for update skip locked
    limit 1;

  if candidate_id is null then
    return;
  end if;

  return query
    update public.sitelift_crm_sync j
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

-- A worker may finalize only the exact claim it owns.
create or replace function public.finish_sitelift_crm_sync(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_next_attempt_at timestamptz,
  p_error_code text,
  p_external_record_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  if p_status not in ('synced', 'retryable', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_crm_sync_status';
  end if;

  update public.sitelift_crm_sync
    set status = p_status,
        next_attempt_at = case when p_status = 'retryable' then p_next_attempt_at else null end,
        last_error_code = case when p_status = 'synced' then null else left(coalesce(p_error_code, 'crm_sync_failed'), 80) end,
        external_record_id = case when p_status = 'synced' then nullif(left(coalesce(p_external_record_id, ''), 200), '') else external_record_id end,
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

revoke all on function public.claim_sitelift_crm_sync(uuid) from public, anon, authenticated;
revoke all on function public.finish_sitelift_crm_sync(uuid,uuid,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.claim_sitelift_crm_sync(uuid) to service_role;
grant execute on function public.finish_sitelift_crm_sync(uuid,uuid,text,timestamptz,text,text) to service_role;
