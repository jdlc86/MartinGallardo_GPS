alter table public.operation_flow_sessions
  alter column expires_at set default (now() + interval '22 hours');

update public.operation_flow_sessions
set expires_at = created_at + interval '22 hours',
    updated_at = now()
where status = 'active'
  and expires_at > now()
  and expires_at < created_at + interval '22 hours';
