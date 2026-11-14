-- WEB-01C: durable unattended Paystack recovery.
-- Additive only. Apply only after separate staging-application authorization.
begin;

alter table public.audit_payments
  add column if not exists processing_lease_token uuid;

create table public.payment_recovery_jobs (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique
    references public.audit_payments(reference) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'dead_letter')),
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  max_attempts integer not null default 8
    check (max_attempts = 8),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  pre_claim_payment_status text
    check (
      pre_claim_payment_status is null
      or pre_claim_payment_status in ('pending', 'initialization_unknown')
    ),
  last_error_code text
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9_]{1,64}$'
    ),
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  constraint payment_recovery_lease_state_check check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or
    (status <> 'processing' and lease_token is null and lease_expires_at is null)
  ),
  constraint payment_recovery_terminal_state_check check (
    (status = 'completed' and completed_at is not null and dead_lettered_at is null)
    or
    (status = 'dead_letter' and dead_lettered_at is not null and completed_at is null)
    or
    (status in ('pending', 'processing') and completed_at is null and dead_lettered_at is null)
  )
);

create index payment_recovery_jobs_pending_idx
  on public.payment_recovery_jobs (next_attempt_at, created_at)
  where status = 'pending';

create index payment_recovery_jobs_expired_lease_idx
  on public.payment_recovery_jobs (lease_expires_at)
  where status = 'processing';

create index payment_recovery_jobs_status_created_idx
  on public.payment_recovery_jobs (status, created_at);

alter table public.payment_recovery_jobs enable row level security;
revoke all on public.payment_recovery_jobs from public, anon, authenticated;
revoke all on public.payment_recovery_jobs from service_role;

comment on table public.payment_recovery_jobs is
  'Durable, idempotent queue for server-side recovery of verified Paystack payment events. Service-role RPC access only.';
comment on column public.audit_payments.processing_lease_token is
  'Fencing token mirrored from payment_recovery_jobs. State-changing worker operations require an exact match and an unexpired lease.';

-- Idempotent durable enqueue. This function does not perform payment fulfillment.
create or replace function public.enqueue_payment_recovery_job(p_reference text)
returns table (accepted boolean, duplicate boolean, already_paid boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_payment_status text;
  v_pdf_path text;
  v_inserted_id uuid;
begin
  if p_reference is null or length(p_reference) < 1 or length(p_reference) > 200 then
    return query select false, false, false;
    return;
  end if;

  select ap.status, ap.pdf_path
    into v_payment_status, v_pdf_path
  from public.audit_payments ap
  where ap.reference = p_reference;

  if not found
    or (v_payment_status <> 'paid' and v_payment_status not in ('pending', 'processing', 'initialization_unknown'))
    or (v_payment_status = 'paid' and v_pdf_path is null) then
    return query select false, false, false;
    return;
  end if;

  insert into public.payment_recovery_jobs (reference)
  values (p_reference)
  on conflict (reference) do nothing
  returning id into v_inserted_id;

  if v_payment_status = 'paid' and v_pdf_path is not null then
    update public.payment_recovery_jobs j
      set status = 'completed',
          lease_token = null,
          lease_expires_at = null,
          completed_at = coalesce(j.completed_at, clock_timestamp()),
          dead_lettered_at = null,
          updated_at = clock_timestamp()
    where j.reference = p_reference
      and j.status <> 'completed';
  end if;


  return query
    select true, v_inserted_id is null,
      (v_payment_status = 'paid' and v_pdf_path is not null);
end;
$$;

-- Atomically claim one due job and its payment row.
-- Lease duration is fixed at the approved 120 seconds; database time is authoritative.
create or replace function public.claim_payment_recovery_job()
returns table (
  reference text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer,
  payment_id uuid,
  audit_id uuid,
  amount integer,
  currency text,
  pre_claim_payment_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_now timestamptz := clock_timestamp();
  v_token uuid;
  v_pre_status text;
begin
  select j.* into v_job
  from public.payment_recovery_jobs j
  where (
      (j.status = 'pending' and j.next_attempt_at <= v_now)
      or
      (j.status = 'processing' and j.lease_expires_at <= v_now)
    )
  order by
    case when j.status = 'pending' then j.next_attempt_at else j.lease_expires_at end,
    j.created_at
  limit 1
  for update skip locked;

  if not found then
    return;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = v_job.reference
  for update;

  if not found then
    return;
  end if;

  -- Payment fulfillment already committed: reconcile the queue without reprocessing.
  if v_payment.status = 'paid' and v_payment.pdf_path is not null then
    update public.payment_recovery_jobs
      set status = 'completed',
          lease_token = null,
          lease_expires_at = null,
          completed_at = coalesce(completed_at, v_now),
          dead_lettered_at = null,
          updated_at = v_now
    where id = v_job.id;
    return;
  end if;

  -- A processing job may only be reclaimed when its old token still owns
  -- the payment row. A tokenless legacy claim is handled by the 3-minute rule.
  if v_payment.status = 'processing' then
    if v_payment.processing_lease_token is not null then
      if v_job.status <> 'processing'
        or v_job.lease_token is distinct from v_payment.processing_lease_token
        or v_job.lease_expires_at > v_now then
        return;
      end if;
    elsif v_job.status <> 'pending'
      or v_payment.processing_started_at is null
      or v_payment.processing_started_at > v_now - interval '3 minutes' then
      return;
    end if;
  elsif v_payment.status not in ('pending', 'initialization_unknown')
    or v_payment.processing_lease_token is not null then
    return;
  end if;

  -- A worker that crashed on its final permitted attempt is dead-lettered
  -- after lease expiry, with the payment claim released safely.
  if v_job.attempt_count >= v_job.max_attempts then
    if v_payment.status = 'processing' then
      update public.audit_payments
        set status = coalesce(v_job.pre_claim_payment_status, 'pending'),
            processing_started_at = null,
            processing_lease_token = null
      where id = v_payment.id
        and status = 'processing'
        and (
          processing_lease_token = v_job.lease_token
          or (
            processing_lease_token is null
            and processing_started_at <= v_now - interval '3 minutes'
          )
        );
    end if;

    update public.payment_recovery_jobs
      set status = 'dead_letter',
          lease_token = null,
          lease_expires_at = null,
          pre_claim_payment_status = coalesce(pre_claim_payment_status, 'pending'),
          dead_lettered_at = v_now,
          updated_at = v_now
    where id = v_job.id;
    return;
  end if;

  if v_payment.status = 'processing' then
    -- Preserve the original state across expired-lease reclamation.
    v_pre_status := coalesce(v_job.pre_claim_payment_status, 'pending');
  else
    v_pre_status := v_payment.status;
  end if;

  v_token := gen_random_uuid();

  update public.payment_recovery_jobs
    set status = 'processing',
        attempt_count = v_job.attempt_count + 1,
        lease_token = v_token,
        lease_expires_at = v_now + interval '120 seconds',
        pre_claim_payment_status = v_pre_status,
        completed_at = null,
        dead_lettered_at = null,
        updated_at = v_now
  where id = v_job.id;

  update public.audit_payments
    set status = 'processing',
        processing_started_at = v_now,
        processing_lease_token = v_token
  where id = v_payment.id;

  return query
    select v_job.reference,
      v_token,
      v_now + interval '120 seconds',
      v_job.attempt_count + 1,
      v_payment.id,
      v_payment.audit_id,
      v_payment.amount,
      v_payment.currency,
      v_pre_status;
end;
$$;

-- Fenced ownership assertion. Call after provider verification and before
-- PDF generation/upload; a false result requires immediate worker termination.
create or replace function public.assert_payment_recovery_lease(
  p_reference text,
  p_lease_token uuid
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
    from public.payment_recovery_jobs j
    join public.audit_payments ap on ap.reference = j.reference
    where j.reference = p_reference
      and j.status = 'processing'
      and j.lease_token = p_lease_token
      and j.lease_expires_at > clock_timestamp()
      and ap.status = 'processing'
      and ap.processing_lease_token = p_lease_token
  );
$$;

-- The database is the sole authority for paid entitlement. Storage upload is
-- deliberately outside this transaction; p_pdf_path is constrained to the
-- deterministic payment-owned path.
create or replace function public.complete_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_transaction_id text,
  p_pdf_path text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_reference is null
    or p_lease_token is null
    or p_transaction_id is null
    or length(p_transaction_id) = 0
    or length(p_transaction_id) > 128
    or p_pdf_path is null then
    return false;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now then
    return false;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token
    or p_pdf_path <> v_payment.audit_id::text || '/' || p_reference || '.pdf' then
    return false;
  end if;

  update public.audit_payments
    set status = 'paid',
        paystack_transaction_id = p_transaction_id,
        paid_at = v_now,
        pdf_path = p_pdf_path,
        webhook_processed_at = v_now,
        processing_started_at = null,
        processing_lease_token = null
  where id = v_payment.id;

  update public.payment_recovery_jobs
    set status = 'completed',
        lease_token = null,
        lease_expires_at = null,
        completed_at = v_now,
        dead_lettered_at = null,
        updated_at = v_now
  where id = v_job.id;

  return true;
end;
$$;

-- Fenced failure/retry transition. Error values are sanitized identifiers only.
create or replace function public.fail_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_now timestamptz := clock_timestamp();
  v_dead boolean;
  v_delay interval;
  v_code text;
begin
  if p_reference is null
    or p_lease_token is null
    or p_retryable is null
    or p_error_code is null
    or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    return 'invalid_input';
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now then
    return 'lease_lost';
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token then
    return 'lease_lost';
  end if;

  v_dead := (not p_retryable) or v_job.attempt_count >= v_job.max_attempts;
  v_code := p_error_code;

  update public.audit_payments
    set status = coalesce(v_job.pre_claim_payment_status, 'pending'),
        processing_started_at = null,
        processing_lease_token = null
  where id = v_payment.id;

  if v_dead then
    update public.payment_recovery_jobs
      set status = 'dead_letter',
          lease_token = null,
          lease_expires_at = null,
          last_error_code = v_code,
          last_error_at = v_now,
          dead_lettered_at = v_now,
          updated_at = v_now
    where id = v_job.id;
    return 'dead_letter';
  end if;

  v_delay := case v_job.attempt_count
    when 1 then interval '1 minute'
    when 2 then interval '2 minutes'
    when 3 then interval '5 minutes'
    when 4 then interval '10 minutes'
    when 5 then interval '20 minutes'
    else interval '30 minutes'
  end;

  update public.payment_recovery_jobs
    set status = 'pending',
        next_attempt_at = v_now + v_delay,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = v_code,
        last_error_at = v_now,
        updated_at = v_now
  where id = v_job.id;

  return 'retry_scheduled';
end;
$$;

revoke all on function public.enqueue_payment_recovery_job(text) from public, anon, authenticated;
revoke all on function public.claim_payment_recovery_job() from public, anon, authenticated;
revoke all on function public.assert_payment_recovery_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.complete_payment_recovery_job(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_payment_recovery_job(text, uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.enqueue_payment_recovery_job(text) to service_role;
grant execute on function public.claim_payment_recovery_job() to service_role;
grant execute on function public.assert_payment_recovery_lease(text, uuid) to service_role;
grant execute on function public.complete_payment_recovery_job(text, uuid, text, text) to service_role;
grant execute on function public.fail_payment_recovery_job(text, uuid, text, boolean) to service_role;

commit;
