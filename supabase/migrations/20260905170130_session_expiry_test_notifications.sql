alter table public.operation_flow_sessions
  alter column expires_at set default (now() + interval '5 minutes');

create or replace function public.emit_operation_flow_expiry_warnings()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
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
      when 'pickup' then 'La Recogida activa caducará en menos de 2 minutos. Termínala ahora o tendrás que revalidar la operación antes de continuar.'
      when 'park' then 'El Aparcamiento activo caducará en menos de 2 minutos. Termínalo ahora o tendrás que revalidar la operación antes de continuar.'
      when 'relocate' then 'La Reubicación activa caducará en menos de 2 minutos. Termínala ahora o tendrás que revalidar la operación antes de continuar.'
      when 'delivery' then 'La Entrega activa caducará en menos de 2 minutos. Termínala ahora o tendrás que revalidar la operación antes de continuar.'
      else 'Tu operación activa caducará en menos de 2 minutos. Termínala ahora para evitar que la sesión expire.'
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
  return v_count;
end;
$function$;

revoke all on function public.emit_operation_flow_expiry_warnings() from public, anon, authenticated;

do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='operation-flow-expiry-warnings';
  if v_job is not null then
    perform cron.unschedule(v_job);
  end if;
  perform cron.schedule(
    'operation-flow-expiry-warnings',
    '* * * * *',
    'select public.emit_operation_flow_expiry_warnings();'
  );
end $$;
