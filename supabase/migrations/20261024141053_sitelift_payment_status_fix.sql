-- Forward-only correction for production databases where the original
-- payment-processing migration was already recorded before initialization_unknown
-- was added to the application state machine.
alter table public.audit_payments
  drop constraint if exists audit_payments_status_check;

alter table public.audit_payments
  add constraint audit_payments_status_check
  check (status in (
    'pending',
    'processing',
    'initialization_unknown',
    'initialization_failed',
    'paid'
  ));
