-- Restore the original re-entry notification when the user's current Mini App
-- access session expires, while suppressing stale/superseded session noise.
--
-- The access-session TTL remains unchanged (10 minutes in the current test mode).
-- Production TTL is intentionally not changed here.

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
    returning
      s.id,
      s.telegram_user_id,
      s.auth_date,
      s.expires_at,
      s.created_at
  ),
  notifiable as (
    select e.*
    from expired e
    where not exists (
      select 1
      from public.miniapp_access_sessions newer
      where newer.telegram_user_id = e.telegram_user_id
        and newer.created_at > e.created_at
    )
  ),
  inserted as (
    insert into public.parking_booking_notifications (
      recipient_telegram_user_id,
      notification_type,
      title,
      body,
      payload
    )
    select
      e.telegram_user_id,
      'access_session_expired',
      'Sesión de ParkingMartin-G caducada',
      'Tu sesión de acceso ha caducado. Pulsa el botón inferior para volver a abrir ParkingMartin-G y entrar con una sesión nueva.',
      jsonb_build_object(
        'access_session_id', e.id,
        'auth_date', e.auth_date,
        'expired_at', e.expires_at
      )
    from notifiable e
    where not exists (
      select 1
      from public.parking_booking_notifications n
      where n.notification_type = 'access_session_expired'
        and n.payload->>'access_session_id' = e.id::text
    )
    returning 1
  )
  select count(*)::integer into v_count
  from inserted;

  return v_count;
end;
$function$;

revoke all on function public.emit_miniapp_access_session_expiry_notifications()
  from public, anon, authenticated;
