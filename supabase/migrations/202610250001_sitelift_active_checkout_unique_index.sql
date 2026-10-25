-- Forward-only corrective migration for the active-checkout race guard.
-- Keep this separate from historical migrations already recorded in production.
do $$
begin
  if exists (
    select 1
    from public.audit_payments
    where status in ('pending', 'processing', 'initialization_unknown')
    group by audit_id
    having count(*) > 1
  ) then
    raise exception
      'Cannot create active-checkout unique index: duplicate active checkouts exist';
  end if;
end
$$;

create unique index if not exists audit_payments_one_active_checkout_per_audit_idx
  on public.audit_payments (audit_id)
  where status in ('pending', 'processing', 'initialization_unknown');
