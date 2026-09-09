-- Production session TTLs requested 2026-09-09.
-- Access-session TTL is enforced by miniapp-access-session-api (22 hours).
-- Operation flow sessions are extended from the temporary 5-minute test value to 20 minutes.

alter table public.operation_flow_sessions
  alter column expires_at set default (now() + interval '20 minutes');

update public.operation_flow_sessions
set expires_at = created_at + interval '20 minutes',
    updated_at = now()
where status = 'active'
  and expires_at > now()
  and expires_at < created_at + interval '20 minutes';
