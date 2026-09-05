-- Extend operation flow integrity to pickup.
alter table public.operation_flow_sessions drop constraint if exists operation_flow_sessions_flow_type_check;
alter table public.operation_flow_sessions add constraint operation_flow_sessions_flow_type_check check (flow_type in ('park','delivery','pickup','relocate','search'));

create or replace function public.complete_pickup_flow(
  p_session_id uuid,p_worker_id uuid,p_telegram_user_id bigint,p_plate text,p_verification_id uuid
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp
as $$
declare
  s public.operation_flow_sessions%rowtype;
  v public.vehicles%rowtype;
  vr public.plate_verifications%rowtype;
  norm_plate text;
  now_ts timestamptz:=now();
  ev_id uuid;
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
  if s.flow_type<>'pickup' or s.worker_id<>p_worker_id or s.telegram_user_id<>p_telegram_user_id or s.normalized_plate<>norm_plate then
    raise exception 'flow_session_context_mismatch';
  end if;
  select * into v from public.vehicles where id=s.vehicle_id and normalized_plate=s.normalized_plate for update;
  if not found then raise exception 'flow_vehicle_mismatch'; end if;
  select * into vr from public.plate_verifications
   where id=p_verification_id and vehicle_id=s.vehicle_id and stage='airport_pickup'
     and result in ('matched','overridden')
     and metadata->>'flow_session_id'=s.id::text;
  if not found then raise exception 'verification_session_mismatch'; end if;

  update public.vehicles set status='in_transit',retrieved_at=null,last_updated_by=p_worker_id,updated_at=now_ts where id=s.vehicle_id;
  insert into public.parking_events(vehicle_id,worker_id,operation,location_text,metadata)
  values(s.vehicle_id,p_worker_id,'pickup','Aeropuerto - recogida del cliente',
    jsonb_build_object('source','modern_pickup','telegram_user_id',p_telegram_user_id,'stage','airport_pickup','flow_session_id',s.id,'plate_verification_id',vr.id))
  returning id into ev_id;
  update public.vehicle_evidence set event_id=ev_id
   where vehicle_id=s.vehicle_id and stage='airport_pickup' and event_id is null
     and metadata->>'flow_session_id'=s.id::text;
  payload:=jsonb_build_object('ok',true,'plate',v.plate,'vehicle_id',s.vehicle_id,'picked_up_at',now_ts,'flow_session_id',s.id,'idempotent',false);
  update public.operation_flow_sessions set status='completed',current_step='completed',result=payload,completed_at=now_ts,updated_at=now_ts where id=s.id;
  return payload;
end;
$$;
revoke all on function public.complete_pickup_flow(uuid,uuid,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.complete_pickup_flow(uuid,uuid,bigint,text,uuid) to service_role;
