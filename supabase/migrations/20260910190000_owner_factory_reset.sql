begin;

create table if not exists public.factory_reset_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by_telegram_user_id bigint not null,
  status text not null default 'preview' check (status in ('preview','running','completed','failed')),
  override_disputes boolean not null default false,
  preview jsonb not null default '{}'::jsonb,
  storage_objects_deleted integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.factory_reset_runs enable row level security;
revoke all on public.factory_reset_runs from anon, authenticated;
grant select, insert, update on public.factory_reset_runs to service_role;

create unique index if not exists factory_reset_one_running_idx
on public.factory_reset_runs ((1)) where status='running';

create or replace function public.factory_reset_assert_owner(p_owner_id bigint)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists (
    select 1 from public.telegram_users
    where telegram_user_id=p_owner_id and active=true and role='owner'
  ) then
    raise exception 'factory_reset_owner_required';
  end if;
end;
$$;

create or replace function public.factory_reset_preview(p_owner_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public,storage
as $$
declare
  v_preview jsonb;
  v_run public.factory_reset_runs;
begin
  perform public.factory_reset_assert_owner(p_owner_id);

  select jsonb_build_object(
    'vehicles',(select count(*) from public.vehicles),
    'vehicle_stays',(select count(*) from public.vehicle_stays),
    'parking_events',(select count(*) from public.parking_events),
    'vehicle_evidence',(select count(*) from public.vehicle_evidence),
    'vehicle_photos',(select count(*) from public.vehicle_photos),
    'plate_verifications',(select count(*) from public.plate_verifications),
    'vehicle_share_links',(select count(*) from public.vehicle_share_links),
    'operation_flow_sessions',(select count(*) from public.operation_flow_sessions),
    'parking_bookings',(select count(*) from public.parking_bookings),
    'reservation_tasks',(select count(*) from public.reservation_tasks),
    'ai_dispatch_plans',(select count(*) from public.ai_dispatch_plans),
    'ai_dispatch_sessions',(select count(*) from public.ai_dispatch_sessions),
    'optimization_jobs',(select count(*) from public.optimization_jobs),
    'worker_daily_presence',(select count(*) from public.worker_daily_presence),
    'worker_live_locations',(select count(*) from public.worker_live_locations),
    'non_owner_telegram_users',(select count(*) from public.telegram_users where telegram_user_id<>p_owner_id),
    'workers_to_remove',(select count(*) from public.workers where telegram_user_id is distinct from p_owner_id),
    'app_users_to_remove',(select count(*) from public.app_users where telegram_user_id<>p_owner_id),
    'open_disputes',(select count(*) from public.vehicle_disputes where status='open'),
    'storage_objects',(select count(*) from storage.objects where bucket_id='vehicle-evidence'),
    'storage_bytes',coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id='vehicle-evidence' and metadata ? 'size'),0),
    'preserved',jsonb_build_array(
      'parking_config','parking_sectors','evidence_requirements','ai_dispatch_config','ai_dispatch_nodes','ai_dispatch_route_matrix',
      'database_health_config','resource_observability_config','data_retention_config','maintenance_tasks','config_audit',
      'database_health_reports','resource_usage_snapshots','maintenance_cleanup_runs','maintenance_runner_runs','factory_reset_runs','miniapps','owner'
    )
  ) into v_preview;

  insert into public.factory_reset_runs(requested_by_telegram_user_id,preview)
  values(p_owner_id,v_preview)
  returning * into v_run;

  return jsonb_build_object('reset_id',v_run.id,'expires_at',v_run.expires_at,'preview',v_preview);
end;
$$;

create or replace function public.factory_reset_storage_objects(p_reset_id uuid,p_owner_id bigint)
returns table(bucket text,path text)
language plpgsql
security definer
set search_path=public,storage
as $$
begin
  perform public.factory_reset_assert_owner(p_owner_id);
  if not exists(select 1 from public.factory_reset_runs where id=p_reset_id and requested_by_telegram_user_id=p_owner_id and status in ('preview','running') and expires_at>now()) then
    raise exception 'factory_reset_invalid_or_expired';
  end if;
  return query select o.bucket_id::text,o.name::text from storage.objects o where o.bucket_id='vehicle-evidence' order by o.name;
end;
$$;

create or replace function public.factory_reset_claim(p_reset_id uuid,p_owner_id bigint,p_override_disputes boolean default false)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_open bigint;
  v_row public.factory_reset_runs;
begin
  perform public.factory_reset_assert_owner(p_owner_id);
  select * into v_row from public.factory_reset_runs where id=p_reset_id for update;
  if not found or v_row.requested_by_telegram_user_id<>p_owner_id or v_row.status<>'preview' or v_row.expires_at<=now() then
    raise exception 'factory_reset_invalid_or_expired';
  end if;
  select count(*) into v_open from public.vehicle_disputes where status='open';
  if v_open>0 and not p_override_disputes then raise exception 'factory_reset_open_disputes'; end if;
  update public.factory_reset_runs set status='running',override_disputes=p_override_disputes,started_at=now(),error=null where id=p_reset_id;
  return jsonb_build_object('claimed',true,'open_disputes',v_open);
exception when unique_violation then
  raise exception 'factory_reset_already_running';
end;
$$;

create or replace function public.factory_reset_fail(p_reset_id uuid,p_owner_id bigint,p_error text)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  perform public.factory_reset_assert_owner(p_owner_id);
  update public.factory_reset_runs set status='failed',error=left(coalesce(p_error,'factory_reset_failed'),1000),completed_at=now()
  where id=p_reset_id and requested_by_telegram_user_id=p_owner_id and status='running';
end;
$$;

create or replace function public.factory_reset_finalize(p_reset_id uuid,p_owner_id bigint,p_storage_objects_deleted integer default 0)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.factory_reset_runs;
  v_result jsonb;
begin
  perform public.factory_reset_assert_owner(p_owner_id);
  select * into v_row from public.factory_reset_runs where id=p_reset_id for update;
  if not found or v_row.requested_by_telegram_user_id<>p_owner_id or v_row.status<>'running' then
    raise exception 'factory_reset_not_running';
  end if;

  -- Config/reference rows remain. Clear only actor references that would point to users/workers removed below.
  update public.config_audit set worker_id=null where worker_id in (select id from public.workers where telegram_user_id is distinct from p_owner_id);
  update public.parking_config set updated_by=null where updated_by in (select id from public.workers where telegram_user_id is distinct from p_owner_id);
  update public.parking_sectors set created_by=null where created_by in (select id from public.workers where telegram_user_id is distinct from p_owner_id);
  update public.data_retention_config set updated_by_telegram_user_id=null where updated_by_telegram_user_id is distinct from p_owner_id;

  -- Vehicle/stay operation.
  delete from public.operation_flow_sessions;
  delete from public.plate_verifications;
  delete from public.vehicle_photos;
  delete from public.vehicle_evidence;
  delete from public.vehicle_share_links;
  delete from public.vehicle_disputes;
  delete from public.parking_events;
  delete from public.vehicle_stays;
  delete from public.vehicles;

  -- Reservations/imports/tasks.
  delete from public.reservation_task_assignment_history;
  delete from public.reservation_tasks;
  delete from public.parking_booking_notifications;
  delete from public.parking_booking_admin_events;
  delete from public.parking_booking_permission_requests;
  delete from public.parking_booking_command_dedup;
  delete from public.parking_booking_write_state;
  delete from public.parking_bookings;
  delete from public.parking_booking_import_batches;
  delete from public.parking_booking_import_analyses;

  -- Optimizer/AI operational state.
  delete from public.optimization_job_events;
  delete from public.optimization_jobs;
  delete from public.ai_dispatch_sessions;
  delete from public.ai_dispatch_plans;

  -- Presence, sessions and operational audit.
  delete from public.worker_daily_presence;
  delete from public.worker_live_locations;
  delete from public.miniapp_access_sessions;
  delete from public.telegram_conversation_sessions;
  delete from public.telegram_access_requests;
  delete from public.user_admin_events;
  delete from public.audit_events;
  delete from public.performance_report_dispatches;

  -- Preserve the executing Owner; remove test/admin/operator identities.
  update public.app_users set approved_by=null,disabled_by=null where telegram_user_id=p_owner_id;
  delete from public.app_users where telegram_user_id<>p_owner_id;
  delete from public.workers where telegram_user_id is distinct from p_owner_id;
  delete from public.telegram_users where telegram_user_id<>p_owner_id;

  update public.factory_reset_runs
  set status='completed',storage_objects_deleted=greatest(coalesce(p_storage_objects_deleted,0),0),completed_at=now(),error=null
  where id=p_reset_id;

  select jsonb_build_object(
    'completed',true,
    'reset_id',p_reset_id,
    'storage_objects_deleted',greatest(coalesce(p_storage_objects_deleted,0),0),
    'owner_preserved',(select count(*) from public.telegram_users where telegram_user_id=p_owner_id and role='owner'),
    'vehicles_remaining',(select count(*) from public.vehicles),
    'bookings_remaining',(select count(*) from public.parking_bookings),
    'evidence_metadata_remaining',(select count(*) from public.vehicle_evidence)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.factory_reset_assert_owner(bigint) from public,anon,authenticated;
revoke all on function public.factory_reset_preview(bigint) from public,anon,authenticated;
revoke all on function public.factory_reset_storage_objects(uuid,bigint) from public,anon,authenticated;
revoke all on function public.factory_reset_claim(uuid,bigint,boolean) from public,anon,authenticated;
revoke all on function public.factory_reset_fail(uuid,bigint,text) from public,anon,authenticated;
revoke all on function public.factory_reset_finalize(uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.factory_reset_assert_owner(bigint) to service_role;
grant execute on function public.factory_reset_preview(bigint) to service_role;
grant execute on function public.factory_reset_storage_objects(uuid,bigint) to service_role;
grant execute on function public.factory_reset_claim(uuid,bigint,boolean) to service_role;
grant execute on function public.factory_reset_fail(uuid,bigint,text) to service_role;
grant execute on function public.factory_reset_finalize(uuid,bigint,integer) to service_role;

commit;
