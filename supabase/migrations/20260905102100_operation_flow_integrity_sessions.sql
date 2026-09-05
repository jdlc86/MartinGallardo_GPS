-- Operation-flow integrity sessions for parking and delivery.
-- Applied to production before this migration was committed.

create table if not exists public.operation_flow_sessions (
  id uuid primary key default gen_random_uuid(),
  flow_type text not null check (flow_type in ('park','delivery')),
  normalized_plate text not null,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  worker_id uuid not null references public.workers(id) on delete restrict,
  telegram_user_id bigint not null,
  task_id uuid null references public.reservation_tasks(id) on delete set null,
  booking_id uuid null references public.parking_bookings(id) on delete set null,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  current_step text not null default 'started',
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  completed_at timestamptz null,
  cancelled_at timestamptz null
);

create index if not exists operation_flow_sessions_worker_status_idx
  on public.operation_flow_sessions(worker_id,status,created_at desc);
create index if not exists operation_flow_sessions_vehicle_status_idx
  on public.operation_flow_sessions(vehicle_id,status,created_at desc);
create unique index if not exists operation_flow_sessions_one_active_per_worker_flow
  on public.operation_flow_sessions(worker_id,flow_type)
  where status='active';

alter table public.operation_flow_sessions enable row level security;
revoke all on table public.operation_flow_sessions from anon, authenticated;
grant select,insert,update,delete on table public.operation_flow_sessions to service_role;

create or replace function public.complete_parking_flow(
  p_session_id uuid,p_worker_id uuid,p_telegram_user_id bigint,p_plate text,
  p_verification_id uuid,p_latitude double precision,p_longitude double precision,
  p_accuracy_m numeric,p_location_text text,p_location_mode text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s public.operation_flow_sessions%rowtype;
  v public.vehicles%rowtype;
  vr public.plate_verifications%rowtype;
  norm_plate text;
  now_ts timestamptz := now();
  payload jsonb;
begin
  norm_plate := regexp_replace(upper(coalesce(p_plate,'')), '[^A-Z0-9]', '', 'g');
  select * into s from public.operation_flow_sessions where id=p_session_id for update;
  if not found then raise exception 'flow_session_not_found'; end if;
  if s.status='completed' then return s.result || jsonb_build_object('idempotent',true); end if;
  if s.status<>'active' then raise exception 'flow_session_not_active'; end if;
  if s.expires_at<=now_ts then
    update public.operation_flow_sessions set status='cancelled',cancelled_at=now_ts,updated_at=now_ts where id=s.id;
    raise exception 'flow_session_expired';
  end if;
  if s.flow_type<>'park' or s.worker_id<>p_worker_id or s.telegram_user_id<>p_telegram_user_id or s.normalized_plate<>norm_plate then
    raise exception 'flow_session_context_mismatch';
  end if;
  select * into v from public.vehicles where id=s.vehicle_id and normalized_plate=s.normalized_plate for update;
  if not found then raise exception 'flow_vehicle_mismatch'; end if;
  if v.status='parked' then raise exception 'state_changed'; end if;
  select * into vr from public.plate_verifications
   where id=p_verification_id and vehicle_id=s.vehicle_id and stage='parking'
     and result in ('matched','overridden')
     and metadata->>'flow_session_id'=s.id::text;
  if not found then raise exception 'verification_session_mismatch'; end if;
  if p_location_mode not in ('gps','manual') then raise exception 'invalid_location_mode'; end if;
  if p_location_mode='manual' and nullif(btrim(coalesce(p_location_text,'')),'') is null then raise exception 'location_description_required'; end if;
  if p_location_mode='gps' and (p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180) then
    raise exception 'invalid_coordinates';
  end if;
  update public.vehicles set
    plate=p_plate,status='parked',
    current_lat=case when p_location_mode='gps' then p_latitude else null end,
    current_lng=case when p_location_mode='gps' then p_longitude else null end,
    current_accuracy_m=case when p_location_mode='gps' then p_accuracy_m else null end,
    current_location_text=nullif(btrim(coalesce(p_location_text,'')),''),
    current_sector_id=null,parked_at=now_ts,retrieved_at=null,last_updated_by=p_worker_id,updated_at=now_ts
  where id=s.vehicle_id;
  insert into public.parking_events(vehicle_id,worker_id,operation,latitude,longitude,accuracy_m,location_text,metadata)
  values (
    s.vehicle_id,p_worker_id,'park',
    case when p_location_mode='gps' then p_latitude else null end,
    case when p_location_mode='gps' then p_longitude else null end,
    case when p_location_mode='gps' then p_accuracy_m else null end,
    nullif(btrim(coalesce(p_location_text,'')),''),
    jsonb_build_object('source','modern_parking','telegram_user_id',p_telegram_user_id,'location_mode',p_location_mode,'flow_session_id',s.id,'plate_verification_id',vr.id)
  );
  payload := jsonb_build_object('ok',true,'vehicle_id',s.vehicle_id,'plate',p_plate,'parked_at',now_ts,'accuracy_m',case when p_location_mode='gps' then p_accuracy_m else null end,'location_text',nullif(btrim(coalesce(p_location_text,'')),''),'location_mode',p_location_mode,'flow_session_id',s.id,'idempotent',false);
  update public.operation_flow_sessions set status='completed',current_step='completed',result=payload,completed_at=now_ts,updated_at=now_ts where id=s.id;
  return payload;
end;
$$;

create or replace function public.complete_delivery_flow(
  p_session_id uuid,p_worker_id uuid,p_telegram_user_id bigint,p_plate text,p_verification_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s public.operation_flow_sessions%rowtype;
  v public.vehicles%rowtype;
  vr public.plate_verifications%rowtype;
  norm_plate text;
  now_ts timestamptz := now();
  payload jsonb;
begin
  norm_plate := regexp_replace(upper(coalesce(p_plate,'')), '[^A-Z0-9]', '', 'g');
  select * into s from public.operation_flow_sessions where id=p_session_id for update;
  if not found then raise exception 'flow_session_not_found'; end if;
  if s.status='completed' then return s.result || jsonb_build_object('idempotent',true); end if;
  if s.status<>'active' then raise exception 'flow_session_not_active'; end if;
  if s.expires_at<=now_ts then
    update public.operation_flow_sessions set status='cancelled',cancelled_at=now_ts,updated_at=now_ts where id=s.id;
    raise exception 'flow_session_expired';
  end if;
  if s.flow_type<>'delivery' or s.worker_id<>p_worker_id or s.telegram_user_id<>p_telegram_user_id or s.normalized_plate<>norm_plate then
    raise exception 'flow_session_context_mismatch';
  end if;
  select * into v from public.vehicles where id=s.vehicle_id and normalized_plate=s.normalized_plate for update;
  if not found then raise exception 'flow_vehicle_mismatch'; end if;
  if v.status<>'parked' then raise exception 'state_changed'; end if;
  select * into vr from public.plate_verifications
   where id=p_verification_id and vehicle_id=s.vehicle_id and stage='parking_exit'
     and result in ('matched','overridden')
     and metadata->>'flow_session_id'=s.id::text;
  if not found then raise exception 'verification_session_mismatch'; end if;
  update public.vehicles set status='retrieved',retrieved_at=now_ts,last_updated_by=p_worker_id,updated_at=now_ts where id=s.vehicle_id;
  insert into public.parking_events(vehicle_id,worker_id,operation,location_text,metadata)
  values (s.vehicle_id,p_worker_id,'retrieve','Aeropuerto - entrega al cliente',
    jsonb_build_object('source','modern_delivery','telegram_user_id',p_telegram_user_id,'stage','airport_delivery','plate_verification_id',vr.id,'flow_session_id',s.id));
  payload := jsonb_build_object('ok',true,'plate',v.plate,'vehicle_id',s.vehicle_id,'retrieved_at',now_ts,'flow_session_id',s.id,'idempotent',false);
  update public.operation_flow_sessions set status='completed',current_step='completed',result=payload,completed_at=now_ts,updated_at=now_ts where id=s.id;
  return payload;
end;
$$;

revoke all on function public.complete_parking_flow(uuid,uuid,bigint,text,uuid,double precision,double precision,numeric,text,text) from public,anon,authenticated;
revoke all on function public.complete_delivery_flow(uuid,uuid,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.complete_parking_flow(uuid,uuid,bigint,text,uuid,double precision,double precision,numeric,text,text) to service_role;
grant execute on function public.complete_delivery_flow(uuid,uuid,bigint,text,uuid) to service_role;
