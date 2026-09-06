alter table public.miniapp_access_sessions
  add column if not exists token_hash text,
  add column if not exists revoked_at timestamptz;

create unique index if not exists miniapp_access_sessions_token_hash_idx
  on public.miniapp_access_sessions(token_hash)
  where token_hash is not null;

create or replace function public.validate_miniapp_access_session(p_token_hash text)
returns table(telegram_user_id bigint, expires_at timestamptz)
language sql
security definer
set search_path=''
as $function$
  select s.telegram_user_id, s.expires_at
  from public.miniapp_access_sessions s
  join public.telegram_users u
    on u.telegram_user_id=s.telegram_user_id
   and u.active=true
  where s.token_hash=p_token_hash
    and s.active=true
    and s.revoked_at is null
    and s.expires_at>now()
  limit 1
$function$;

revoke all on function public.validate_miniapp_access_session(text) from public, anon, authenticated;

create or replace function public.touch_miniapp_access_session(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
begin
  update public.miniapp_access_sessions
     set last_seen_at=now()
   where token_hash=p_token_hash
     and active=true
     and revoked_at is null
     and expires_at>now();
  return found;
end;
$function$;

revoke all on function public.touch_miniapp_access_session(text) from public, anon, authenticated;
