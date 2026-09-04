-- Keep access-request expiration as an internal cron/backend function.
revoke execute on function public.expire_pending_access_requests()
  from public, anon, authenticated;

grant execute on function public.expire_pending_access_requests()
  to service_role;
