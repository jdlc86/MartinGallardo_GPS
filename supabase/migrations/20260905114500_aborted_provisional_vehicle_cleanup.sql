-- Mark provisional vehicles from abandoned initial parking flows as cleanup candidates.
alter table public.vehicles
  add column if not exists aborted_at timestamptz null,
  add column if not exists cleanup_eligible_at timestamptz null,
  add column if not exists cleanup_reason text null;

alter table public.operation_flow_sessions
  add column if not exists vehicle_created_by_session boolean not null default false;

create index if not exists vehicles_cleanup_eligible_idx
  on public.vehicles(cleanup_eligible_at)
  where cleanup_eligible_at is not null;

create or replace function public.cancel_operation_flow_session(
  p_session_id uuid,
  p_worker_id uuid,
  p_telegram_user_id bigint,
  p_flow_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.operation_flow_sessions%rowtype;
  now_ts timestamptz := now();
  marked_aborted boolean := false;
begin
  select * into s from public.operation_flow_sessions where id=p_session_id for update;
  if not found then return jsonb_build_object('ok',true,'cancelled',false,'reason','not_found'); end if;
  if s.worker_id<>p_worker_id or s.telegram_user_id<>p_telegram_user_id or s.flow_type<>p_flow_type then
    raise exception 'flow_session_context_mismatch';
  end if;
  if s.status<>'active' then return jsonb_build_object('ok',true,'cancelled',false,'status',s.status); end if;

  update public.operation_flow_sessions
  set status='cancelled',cancelled_at=now_ts,updated_at=now_ts
  where id=s.id;

  if s.flow_type='park'
     and s.vehicle_created_by_session
     and not exists (
       select 1 from public.parking_events pe
       where pe.vehicle_id=s.vehicle_id and pe.operation='park'
     ) then
    update public.vehicles
    set aborted_at=coalesce(aborted_at,now_ts),
        cleanup_eligible_at=coalesce(cleanup_eligible_at,now_ts + interval '7 days'),
        cleanup_reason=coalesce(cleanup_reason,'cancelled_initial_parking'),
        updated_at=now_ts
    where id=s.vehicle_id
      and status='in_transit'
      and parked_at is null
      and retrieved_at is null;
    marked_aborted := found;
  end if;

  return jsonb_build_object(
    'ok',true,'cancelled',true,'vehicle_marked_aborted',marked_aborted,
    'cleanup_eligible_at',case when marked_aborted then now_ts + interval '7 days' else null end
  );
end;
$$;

revoke all on function public.cancel_operation_flow_session(uuid,uuid,bigint,text)
from public,anon,authenticated;
grant execute on function public.cancel_operation_flow_session(uuid,uuid,bigint,text)
to service_role;
