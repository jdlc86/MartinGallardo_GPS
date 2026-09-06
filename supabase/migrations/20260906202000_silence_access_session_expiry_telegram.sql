-- Routine access-session expiry is enforced in-app and server-side.
-- Do not send a Telegram message for every normal 10-minute access-session expiry.
-- Operation-flow expiry notifications remain unchanged.

create or replace function public.emit_miniapp_access_session_expiry_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  with expired as (
    update public.miniapp_access_sessions s
       set notified_at = now(),
           active = false,
           last_seen_at = now()
     where s.active = true
       and s.notified_at is null
       and s.expires_at <= now()
    returning 1
  )
  select count(*)::integer into v_count from expired;

  return v_count;
end;
$function$;

revoke all on function public.emit_miniapp_access_session_expiry_notifications()
  from public, anon, authenticated;

-- Prevent already-queued routine access-expiry notices from being delivered after this change.
update public.parking_booking_notifications
   set telegram_claimed_at = coalesce(telegram_claimed_at, now()),
       telegram_sent_at = coalesce(telegram_sent_at, now()),
       telegram_error = coalesce(telegram_error, 'suppressed_routine_access_expiry')
 where notification_type = 'access_session_expired'
   and telegram_sent_at is null;
