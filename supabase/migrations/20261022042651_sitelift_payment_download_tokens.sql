alter table public.audit_payments
  add column if not exists download_token text,
  add column if not exists token_expires_at timestamptz;

create unique index if not exists audit_payments_download_token_uidx
  on public.audit_payments (download_token)
  where download_token is not null;

create index if not exists audit_payments_token_expires_at_idx
  on public.audit_payments (token_expires_at);
