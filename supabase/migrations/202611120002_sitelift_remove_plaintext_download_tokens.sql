-- Contract phase: apply only after the application version that reads and
-- writes download_token_hash is deployed everywhere. This removes residual
-- plaintext tokens and the legacy column/index.
begin;

-- Catch any legacy-version checkout created during the rolling application
-- deployment after the expand migration initially backfilled existing rows.
update public.audit_payments
set download_token_hash = encode(digest(convert_to(download_token, 'UTF8'), 'sha256'), 'hex'),
    token_expires_at = least(
      coalesce(token_expires_at, created_at + interval '24 hours'),
      created_at + interval '24 hours'
    )
where download_token is not null
  and download_token_hash is null;

update public.audit_payments
set download_token = null
where download_token is not null;

drop index if exists public.audit_payments_download_token_uidx;

alter table public.audit_payments
  drop column if exists download_token;

commit;
