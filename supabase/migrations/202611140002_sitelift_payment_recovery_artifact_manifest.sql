-- WEB-01C: durable PDF artifact identity and storage verification.
-- Additive migration. Apply only after separate staging-application authorization.
begin;

alter table public.payment_recovery_jobs
  add column artifact_sha256 text,
  add column artifact_size_bytes bigint,
  add constraint payment_recovery_artifact_manifest_check check (
    (artifact_sha256 is null and artifact_size_bytes is null)
    or
    (
      artifact_sha256 is not null
      and artifact_size_bytes between 8 and 26214400
      and artifact_sha256 ~ '^[0-9a-f]{64}    )
  );

comment on column public.payment_recovery_jobs.artifact_sha256 is
  'Immutable SHA-256 digest of the exact deterministic PDF artifact bytes.';
comment on column public.payment_recovery_jobs.artifact_size_bytes is
  'Immutable byte length of the deterministic PDF artifact.';

-- Read the manifest only while the caller owns both unexpired lease tokens.
create or replace function public.get_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid
)
returns table (artifact_sha256 text, artifact_size_bytes bigint)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select j.artifact_sha256, j.artifact_size_bytes
  from public.payment_recovery_jobs j
  join public.audit_payments ap on ap.reference = j.reference
  where j.reference = p_reference
    and j.status = 'processing'
    and j.lease_token = p_lease_token
    and j.lease_expires_at > clock_timestamp()
    and ap.status = 'processing'
    and ap.processing_lease_token = p_lease_token;
$$;

-- Persist the expected artifact identity once. A later lease may reuse the
-- same manifest, but it may never replace it with different bytes.
create or replace function public.record_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
)
returns table (
  artifact_sha256 text,
  artifact_size_bytes bigint,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_created boolean := false;
begin
  if p_reference is null
    or p_lease_token is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null
    or p_artifact_size_bytes < 8
    or p_artifact_size_bytes > 26214400 then
    return;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= clock_timestamp() then
    return;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token then
    return;
  end if;

  if v_job.artifact_sha256 is null and v_job.artifact_size_bytes is null then
    update public.payment_recovery_jobs
      set artifact_sha256 = p_artifact_sha256,
          artifact_size_bytes = p_artifact_size_bytes,
          updated_at = clock_timestamp()
    where id = v_job.id;
    v_created := true;
    return query select p_artifact_sha256, p_artifact_size_bytes, v_created;
    return;
  end if;

  if v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
    return;
  end if;

  return query select v_job.artifact_sha256, v_job.artifact_size_bytes, false;
end;
$$;

-- Replace the former four-argument completion RPC. The new signature requires
-- the worker's verified digest/size to match the immutable persisted manifest.
drop function public.complete_payment_recovery_job(text, uuid, text, text);

create function public.complete_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_transaction_id text,
  p_pdf_path text,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
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
    or p_pdf_path is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null then
    return false;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now
    or v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
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

revoke all on function public.get_payment_recovery_artifact(text, uuid) from public, anon, authenticated;
revoke all on function public.record_payment_recovery_artifact(text, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) from public, anon, authenticated;

grant execute on function public.get_payment_recovery_artifact(text, uuid) to service_role;
grant execute on function public.record_payment_recovery_artifact(text, uuid, text, bigint) to service_role;
grant execute on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) to service_role;

commit;

      and artifact_size_bytes between 8 and 26214400
    )
  );

comment on column public.payment_recovery_jobs.artifact_sha256 is
  'Immutable SHA-256 digest of the exact deterministic PDF artifact bytes.';
comment on column public.payment_recovery_jobs.artifact_size_bytes is
  'Immutable byte length of the deterministic PDF artifact.';

-- Read the manifest only while the caller owns both unexpired lease tokens.
create or replace function public.get_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid
)
returns table (artifact_sha256 text, artifact_size_bytes bigint)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select j.artifact_sha256, j.artifact_size_bytes
  from public.payment_recovery_jobs j
  join public.audit_payments ap on ap.reference = j.reference
  where j.reference = p_reference
    and j.status = 'processing'
    and j.lease_token = p_lease_token
    and j.lease_expires_at > clock_timestamp()
    and ap.status = 'processing'
    and ap.processing_lease_token = p_lease_token;
$$;

-- Persist the expected artifact identity once. A later lease may reuse the
-- same manifest, but it may never replace it with different bytes.
create or replace function public.record_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
)
returns table (
  artifact_sha256 text,
  artifact_size_bytes bigint,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_created boolean := false;
begin
  if p_reference is null
    or p_lease_token is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null
    or p_artifact_size_bytes < 8
    or p_artifact_size_bytes > 26214400 then
    return;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= clock_timestamp() then
    return;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token then
    return;
  end if;

  if v_job.artifact_sha256 is null and v_job.artifact_size_bytes is null then
    update public.payment_recovery_jobs
      set artifact_sha256 = p_artifact_sha256,
          artifact_size_bytes = p_artifact_size_bytes,
          updated_at = clock_timestamp()
    where id = v_job.id;
    v_created := true;
    return query select p_artifact_sha256, p_artifact_size_bytes, v_created;
    return;
  end if;

  if v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
    return;
  end if;

  return query select v_job.artifact_sha256, v_job.artifact_size_bytes, false;
end;
$$;

-- Replace the former four-argument completion RPC. The new signature requires
-- the worker's verified digest/size to match the immutable persisted manifest.
drop function public.complete_payment_recovery_job(text, uuid, text, text);

create function public.complete_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_transaction_id text,
  p_pdf_path text,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
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
    or p_pdf_path is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null then
    return false;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now
    or v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
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

revoke all on function public.get_payment_recovery_artifact(text, uuid) from public, anon, authenticated;
revoke all on function public.record_payment_recovery_artifact(text, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) from public, anon, authenticated;

grant execute on function public.get_payment_recovery_artifact(text, uuid) to service_role;
grant execute on function public.record_payment_recovery_artifact(text, uuid, text, bigint) to service_role;
grant execute on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) to service_role;

commit;

    )
  );

comment on column public.payment_recovery_jobs.artifact_sha256 is
  'Immutable SHA-256 digest of the exact deterministic PDF artifact bytes.';
comment on column public.payment_recovery_jobs.artifact_size_bytes is
  'Immutable byte length of the deterministic PDF artifact.';

-- Read the manifest only while the caller owns both unexpired lease tokens.
create or replace function public.get_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid
)
returns table (artifact_sha256 text, artifact_size_bytes bigint)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select j.artifact_sha256, j.artifact_size_bytes
  from public.payment_recovery_jobs j
  join public.audit_payments ap on ap.reference = j.reference
  where j.reference = p_reference
    and j.status = 'processing'
    and j.lease_token = p_lease_token
    and j.lease_expires_at > clock_timestamp()
    and ap.status = 'processing'
    and ap.processing_lease_token = p_lease_token;
$$;

-- Persist the expected artifact identity once. A later lease may reuse the
-- same manifest, but it may never replace it with different bytes.
create or replace function public.record_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
)
returns table (
  artifact_sha256 text,
  artifact_size_bytes bigint,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_created boolean := false;
begin
  if p_reference is null
    or p_lease_token is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null
    or p_artifact_size_bytes < 8
    or p_artifact_size_bytes > 26214400 then
    return;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= clock_timestamp() then
    return;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token then
    return;
  end if;

  if v_job.artifact_sha256 is null and v_job.artifact_size_bytes is null then
    update public.payment_recovery_jobs
      set artifact_sha256 = p_artifact_sha256,
          artifact_size_bytes = p_artifact_size_bytes,
          updated_at = clock_timestamp()
    where id = v_job.id;
    v_created := true;
    return query select p_artifact_sha256, p_artifact_size_bytes, v_created;
    return;
  end if;

  if v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
    return;
  end if;

  return query select v_job.artifact_sha256, v_job.artifact_size_bytes, false;
end;
$$;

-- Replace the former four-argument completion RPC. The new signature requires
-- the worker's verified digest/size to match the immutable persisted manifest.
drop function public.complete_payment_recovery_job(text, uuid, text, text);

create function public.complete_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_transaction_id text,
  p_pdf_path text,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
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
    or p_pdf_path is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null then
    return false;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now
    or v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
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

revoke all on function public.get_payment_recovery_artifact(text, uuid) from public, anon, authenticated;
revoke all on function public.record_payment_recovery_artifact(text, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) from public, anon, authenticated;

grant execute on function public.get_payment_recovery_artifact(text, uuid) to service_role;
grant execute on function public.record_payment_recovery_artifact(text, uuid, text, bigint) to service_role;
grant execute on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) to service_role;

commit;

      and artifact_size_bytes between 8 and 26214400
    )
  );

comment on column public.payment_recovery_jobs.artifact_sha256 is
  'Immutable SHA-256 digest of the exact deterministic PDF artifact bytes.';
comment on column public.payment_recovery_jobs.artifact_size_bytes is
  'Immutable byte length of the deterministic PDF artifact.';

-- Read the manifest only while the caller owns both unexpired lease tokens.
create or replace function public.get_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid
)
returns table (artifact_sha256 text, artifact_size_bytes bigint)
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select j.artifact_sha256, j.artifact_size_bytes
  from public.payment_recovery_jobs j
  join public.audit_payments ap on ap.reference = j.reference
  where j.reference = p_reference
    and j.status = 'processing'
    and j.lease_token = p_lease_token
    and j.lease_expires_at > clock_timestamp()
    and ap.status = 'processing'
    and ap.processing_lease_token = p_lease_token;
$$;

-- Persist the expected artifact identity once. A later lease may reuse the
-- same manifest, but it may never replace it with different bytes.
create or replace function public.record_payment_recovery_artifact(
  p_reference text,
  p_lease_token uuid,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
)
returns table (
  artifact_sha256 text,
  artifact_size_bytes bigint,
  created boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job public.payment_recovery_jobs%rowtype;
  v_payment public.audit_payments%rowtype;
  v_created boolean := false;
begin
  if p_reference is null
    or p_lease_token is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null
    or p_artifact_size_bytes < 8
    or p_artifact_size_bytes > 26214400 then
    return;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= clock_timestamp() then
    return;
  end if;

  select ap.* into v_payment
  from public.audit_payments ap
  where ap.reference = p_reference
  for update;

  if not found
    or v_payment.status <> 'processing'
    or v_payment.processing_lease_token is distinct from p_lease_token then
    return;
  end if;

  if v_job.artifact_sha256 is null and v_job.artifact_size_bytes is null then
    update public.payment_recovery_jobs
      set artifact_sha256 = p_artifact_sha256,
          artifact_size_bytes = p_artifact_size_bytes,
          updated_at = clock_timestamp()
    where id = v_job.id;
    v_created := true;
    return query select p_artifact_sha256, p_artifact_size_bytes, v_created;
    return;
  end if;

  if v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
    return;
  end if;

  return query select v_job.artifact_sha256, v_job.artifact_size_bytes, false;
end;
$$;

-- Replace the former four-argument completion RPC. The new signature requires
-- the worker's verified digest/size to match the immutable persisted manifest.
drop function public.complete_payment_recovery_job(text, uuid, text, text);

create function public.complete_payment_recovery_job(
  p_reference text,
  p_lease_token uuid,
  p_transaction_id text,
  p_pdf_path text,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
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
    or p_pdf_path is null
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
    or p_artifact_size_bytes is null then
    return false;
  end if;

  select j.* into v_job
  from public.payment_recovery_jobs j
  where j.reference = p_reference
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now
    or v_job.artifact_sha256 is distinct from p_artifact_sha256
    or v_job.artifact_size_bytes is distinct from p_artifact_size_bytes then
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

revoke all on function public.get_payment_recovery_artifact(text, uuid) from public, anon, authenticated;
revoke all on function public.record_payment_recovery_artifact(text, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) from public, anon, authenticated;

grant execute on function public.get_payment_recovery_artifact(text, uuid) to service_role;
grant execute on function public.record_payment_recovery_artifact(text, uuid, text, bigint) to service_role;
grant execute on function public.complete_payment_recovery_job(text, uuid, text, text, text, bigint) to service_role;

commit;
