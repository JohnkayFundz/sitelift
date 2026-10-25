alter table public.audit_payments
  add column if not exists processing_started_at timestamptz;

alter table public.audit_payments
  drop constraint if exists audit_payments_status_check;

alter table public.audit_payments
  add constraint audit_payments_status_check
  check (status = any (array[
    'pending'::text,
    'processing'::text,
    'initialization_unknown'::text,
    'initialization_failed'::text,
    'paid'::text
  ]));

create index if not exists audit_payments_processing_started_at_idx
  on public.audit_payments (processing_started_at)
  where status = 'processing';
