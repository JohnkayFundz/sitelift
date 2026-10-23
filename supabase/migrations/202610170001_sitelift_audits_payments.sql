create extension if not exists pgcrypto;
create table if not exists public.audits (
  id uuid primary key default gen_random_uuid(), target_url text not null, final_url text not null,
  strategy text not null check (strategy in ('mobile','desktop')), report jsonb not null,
  created_at timestamptz not null default now(),
  constraint audits_report_object check (jsonb_typeof(report) = 'object')
);
create index if not exists audits_created_at_idx on public.audits (created_at desc);
create table if not exists public.audit_payments (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete restrict,
  reference text not null unique, amount integer not null check (amount > 0),
  currency text not null default 'NGN' check (currency = 'NGN'), customer_email text not null,
  status text not null default 'pending' check (status in ('pending','processing','initialization_failed','paid')),
  access_code text, paystack_transaction_id text, paid_at timestamptz, pdf_path text, webhook_processed_at timestamptz,
  download_token text, token_expires_at timestamptz, processing_started_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists audit_payments_audit_id_idx on public.audit_payments (audit_id);
create index if not exists audit_payments_status_idx on public.audit_payments (status);
alter table public.audits enable row level security;
alter table public.audit_payments enable row level security;
revoke all on public.audits from anon, authenticated;
revoke all on public.audit_payments from anon, authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audit-reports', 'audit-reports', false, 5242880, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];
