-- Adds an optional WhatsApp contact to new paid-report checkouts.
-- Apply only after reviewing this feature branch and before enabling its new checkout UI.
alter table public.audit_payments
  add column if not exists customer_whatsapp text;
