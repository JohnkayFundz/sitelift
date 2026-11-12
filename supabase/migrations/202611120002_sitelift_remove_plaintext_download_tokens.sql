-- Contract phase: apply only after the application version that reads and
-- writes download_token_hash is deployed everywhere. This removes residual
-- plaintext tokens and the legacy column/index.
begin;

update public.audit_payments
set download_token = null
where download_token is not null;

drop index if exists public.audit_payments_download_token_uidx;

alter table public.audit_payments
  drop column if exists download_token;

commit;
