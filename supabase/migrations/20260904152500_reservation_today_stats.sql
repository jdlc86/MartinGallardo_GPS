-- Reservation dashboard "today" counters must reflect active bookings, not historical parking events.
create or replace function public.parking_booking_operational_snapshot(p_actor_telegram_user_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_result jsonb;
begin
  perform public.parking_booking_require_admin(p_actor_telegram_user_id);
  select jsonb_build_object(
    'statuses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plate',b.vehicle_plate_normalized,
        'status',coalesce(case le.operation when 'pickup' then 'RECOGIDO' when 'park' then 'APARCADO' when 'relocate' then 'REUBICADO' when 'retrieve' then 'ENTREGADO' end,'PENDIENTE'),
        'operation',le.operation,'at',le.created_at))
      from public.parking_bookings b
      left join public.vehicles v on v.normalized_plate=b.vehicle_plate_normalized
      left join lateral (
        select pe.operation,pe.created_at from public.parking_events pe
        where pe.vehicle_id=v.id and pe.operation in ('pickup','park','relocate','retrieve')
        order by pe.created_at desc limit 1
      ) le on true
      where b.deleted_at is null
    ),'[]'::jsonb),
    'stats',jsonb_build_object(
      'pickups_today',(select count(*) from public.parking_bookings b where b.deleted_at is null and b.pickup_date=(now() at time zone 'Europe/Madrid')::date),
      'returns_today',(select count(*) from public.parking_bookings b where b.deleted_at is null and b.return_date=(now() at time zone 'Europe/Madrid')::date),
      'future_pickups',(select count(*) from public.parking_bookings b where b.deleted_at is null and (b.pickup_date+b.pickup_time)>=(now() at time zone 'Europe/Madrid')),
      'future_returns',(select count(*) from public.parking_bookings b where b.deleted_at is null and (b.return_date+b.return_time)>=(now() at time zone 'Europe/Madrid'))
    ),
    'generated_at',now()
  ) into v_result;
  return v_result;
end;
$function$;
