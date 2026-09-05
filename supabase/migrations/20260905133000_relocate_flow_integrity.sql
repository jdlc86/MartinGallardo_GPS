-- Add optimistic vehicle version protection and relocate flow finalizer.
alter table public.operation_flow_sessions
  add column if not exists expected_vehicle_updated_at timestamptz null;

create or replace function public.complete_relocate_flow(
  p_session_id uuid,p_worker_id uuid,p_telegram_user_id bigint,p_plate text,
  p_latitude double precision,p_longitude double precision,p_accuracy_m numeric,
  p_location_text text,p_location_mode text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  s public.operation_flow_sessions%rowtype;
  v public.vehicles%rowtype;
  norm_plate text;
  now_ts timestamptz:=now();
  old_location jsonb;
  payload jsonb;
begin
  norm_plate:=regexp_replace(upper(coalesce(p_plate,'')),'[^A-Z0-9]','','g');
  select * into s from public.operation_flow_sessions where id=p_session_id for update;
  if not found then raise exception 'flow_session_not_found'; end if;
  if s.status='completed' then return s.result || jsonb_build_object('idempotent',true); end if;
  if s.status<>'active' then raise exception 'flow_session_not_active'; end if;
  if s.expires_at<=now_ts then
    update public.operation_flow_sessions set status='cancelled',cancelled_at=now_ts,updated_at=now_ts where id=s.id;
    raise exception 'flow_session_expired';
  end if;
  if s.flow_type<>'relocate' or s.worker_id<>p_worker_id or s.telegram_user_id<>p_telegram_user_id or s.normalized_plate<>norm_plate then
    raise exception 'flow_session_context_mismatch';
  end if;
  select * into v from public.vehicles where id=s.vehicle_id and normalized_plate=s.normalized_plate for update;
  if not found then raise exception 'flow_vehicle_mismatch'; end if;
  if v.status<>'parked' then raise exception 'state_changed'; end if;
  if s.expected_vehicle_updated_at is not null and v.updated_at is distinct from s.expected_vehicle_updated_at then
    raise exception 'state_changed';
  end if;
  if p_location_mode not in ('gps','manual') then raise exception 'invalid_location_mode'; end if;
  if p_location_mode='manual' and nullif(btrim(coalesce(p_location_text,'')),'') is null then raise exception 'location_description_required'; end if;
  if p_location_mode='gps' and (p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180) then raise exception 'invalid_coordinates'; end if;

  old_location:=jsonb_build_object('latitude',v.current_lat,'longitude',v.current_lng,'accuracy_m',v.current_accuracy_m,'location_text',v.current_location_text);

  update public.vehicles set
    current_lat=case when p_location_mode='gps' then p_latitude else null end,
    current_lng=case when p_location_mode='gps' then p_longitude else null end,
    current_accuracy_m=case when p_location_mode='gps' then p_accuracy_m else null end,
    current_location_text=nullif(btrim(coalesce(p_location_text,'')),''),
    current_sector_id=null,last_updated_by=p_worker_id,updated_at=now_ts
  where id=s.vehicle_id;

  insert into public.parking_events(vehicle_id,worker_id,operation,latitude,longitude,accuracy_m,location_text,metadata)
  values(
    s.vehicle_id,p_worker_id,'relocate',
    case when p_location_mode='gps' then p_latitude else null end,
    case when p_location_mode='gps' then p_longitude else null end,
    case when p_location_mode='gps' then p_accuracy_m else null end,
    nullif(btrim(coalesce(p_location_text,'')),''),
    jsonb_build_object(
      'source','modern_relocate','telegram_user_id',p_telegram_user_id,'flow_session_id',s.id,'location_mode',p_location_mode,
      'previous_location',old_location,
      'new_location',jsonb_build_object(
        'latitude',case when p_location_mode='gps' then p_latitude else null end,
        'longitude',case when p_location_mode='gps' then p_longitude else null end,
        'accuracy_m',case when p_location_mode='gps' then p_accuracy_m else null end,
        'location_text',nullif(btrim(coalesce(p_location_text,'')),''),
        'location_mode',p_location_mode
      )
    )
  );

  payload:=jsonb_build_object(
    'ok',true,'vehicle_id',s.vehicle_id,'plate',v.plate,'relocated_at',now_ts,'previous',old_location,
    'current',jsonb_build_object(
      'latitude',case when p_location_mode='gps' then p_latitude else null end,
      'longitude',case when p_location_mode='gps' then p_longitude else null end,
      'accuracy_m',case when p_location_mode='gps' then p_accuracy_m else null end,
      'location_text',nullif(btrim(coalesce(p_location_text,'')),''),
      'location_mode',p_location_mode
    ),
    'flow_session_id',s.id,'idempotent',false
  );

  update public.operation_flow_sessions set status='completed',current_step='completed',result=payload,completed_at=now_ts,updated_at=now_ts where id=s.id;
  return payload;
end;
$$;
revoke all on function public.complete_relocate_flow(uuid,uuid,bigint,text,double precision,double precision,numeric,text,text) from public,anon,authenticated;
grant execute on function public.complete_relocate_flow(uuid,uuid,bigint,text,double precision,double precision,numeric,text,text) to service_role;
