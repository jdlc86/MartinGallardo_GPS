-- Harden the rejected-access helper view.
-- It is backend-only; client roles must not read it directly.
alter view public.telegram_access_requests_visible_rejected
  set (security_invoker = true);

revoke all on table public.telegram_access_requests_visible_rejected
  from anon, authenticated;

grant select on table public.telegram_access_requests_visible_rejected
  to service_role;
