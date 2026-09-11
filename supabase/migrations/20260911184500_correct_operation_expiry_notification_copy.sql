-- Copy-only correction for operation flow expiry notifications.
-- No changes to TTLs, session state, recovery logic, notification types, payloads, or scheduling.

create or replace function public.emit_operation_flow_expiry_warnings()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
  v_expired integer := 0;
begin
  insert into public.parking_booking_notifications (
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  select
    s.telegram_user_id,
    'flow_session_expiring',
    'Tu operación está a punto de caducar',
    case s.flow_type
      when 'pickup' then 'La Recogida activa caducará en menos de 2 minutos. Termínala ahora. Una vez caducada, tendrás que iniciar una nueva Recogida.'
      when 'park' then 'El Aparcamiento activo caducará en menos de 2 minutos. Termínalo ahora. Una vez caducado, tendrás que iniciar un nuevo Aparcamiento.'
      when 'relocate' then 'La Reubicación activa caducará en menos de 2 minutos. Termínala ahora. Una vez caducada, tendrás que iniciar una nueva Reubicación.'
      when 'delivery' then 'La Entrega activa caducará en menos de 2 minutos. Termínala ahora. Una vez caducada, tendrás que iniciar una nueva Entrega.'
      else 'Tu operación activa caducará en menos de 2 minutos. Termínala ahora. Una vez caducada, tendrás que iniciar una nueva operación.'
    end,
    jsonb_build_object(
      'flow_session_id', s.id,
      'flow_type', s.flow_type,
      'plate', s.normalized_plate,
      'expires_at', s.expires_at
    )
  from public.operation_flow_sessions s
  where s.status = 'active'
    and s.expires_at > now()
    and s.expires_at <= now() + interval '2 minutes'
    and not exists (
      select 1
      from public.parking_booking_notifications n
      where n.notification_type = 'flow_session_expiring'
        and n.recipient_telegram_user_id = s.telegram_user_id
        and n.payload->>'flow_session_id' = s.id::text
    );

  get diagnostics v_count = row_count;

  insert into public.parking_booking_notifications (
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  select
    s.telegram_user_id,
    'flow_session_expired',
    'Operación caducada',
    case s.flow_type
      when 'pickup' then 'Tu Recogida ha caducado y ya no puede recuperarse. Abre ParkingMartin-G para iniciar una nueva sesión y comenzar una nueva Recogida.'
      when 'park' then 'Tu Aparcamiento ha caducado y ya no puede recuperarse. Abre ParkingMartin-G para iniciar una nueva sesión y comenzar un nuevo Aparcamiento.'
      when 'relocate' then 'Tu Reubicación ha caducado y ya no puede recuperarse. Abre ParkingMartin-G para iniciar una nueva sesión y comenzar una nueva Reubicación.'
      when 'delivery' then 'Tu Entrega ha caducado y ya no puede recuperarse. Abre ParkingMartin-G para iniciar una nueva sesión y comenzar una nueva Entrega.'
      else 'Tu operación ha caducado y ya no puede recuperarse. Abre ParkingMartin-G para iniciar una nueva sesión y comenzar una nueva operación.'
    end,
    jsonb_build_object(
      'flow_session_id', s.id,
      'flow_type', s.flow_type,
      'plate', s.normalized_plate,
      'expired_at', s.expires_at
    )
  from public.operation_flow_sessions s
  where s.status = 'active'
    and s.expires_at <= now()
    and not exists (
      select 1
      from public.parking_booking_notifications n
      where n.notification_type = 'flow_session_expired'
        and n.recipient_telegram_user_id = s.telegram_user_id
        and n.payload->>'flow_session_id' = s.id::text
    );

  get diagnostics v_expired = row_count;
  return v_count + v_expired;
end;
$function$;

revoke all on function public.emit_operation_flow_expiry_warnings()
  from public, anon, authenticated;
