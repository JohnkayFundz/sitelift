BEGIN;

ALTER TABLE public.audit_payments
  DROP CONSTRAINT IF EXISTS audit_payments_status_check;

ALTER TABLE public.audit_payments
  ADD CONSTRAINT audit_payments_status_check
  CHECK (status IN ('pending', 'processing', 'initialization_unknown', 'initialization_failed', 'paid'));

COMMIT;
