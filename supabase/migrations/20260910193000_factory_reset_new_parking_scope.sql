begin;

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
    'parking_sectors_to_remove',(select count(*) from public.parking_sectors),
    'parking_configuration_will_reset',true,
    'preserved',jsonb_build_array(
      'evidence_requirements','ai_dispatch_config','ai_dispatch_nodes','ai_dispatch_route_matrix',
      'database_health_config','resource_observability_config','data_retention_config','maintenance_tasks','config_audit',
      'database_health_reports','resource_usage_snapshots','maintenance_cleanup_runs','maintenance_runner_runs','factory_reset_runs','miniapps','owner'
    ),
    'reset_to_unconfigured',jsonb_build_array('parking_config','parking_sectors')
  ) into v_preview;

  insert into public.factory_reset_runs(requested_by_telegram_user_id,preview)
  values(p_owner_id,v_preview)
  returning * into v_run;

  return jsonb_build_object('reset_id',v_run.id,'expires_at',v_run.expires_at,'preview',v_preview);
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

  update public.config_audit set worker_id=null
    where worker_id in (select id from public.workers where telegram_user_id is distinct from p_owner_id);
  update public.data_retention_config set updated_by_telegram_user_id=null
    where updated_by_telegram_user_id is distinct from p_owner_id;

  -- Operational business data.
  delete from public.operation_flow_sessions;
  delete from public.plate_verifications;
  delete from public.vehicle_photos;
  delete from public.vehicle_evidence;
  delete from public.vehicle_share_links;
  delete from public.vehicle_disputes;
  delete from public.parking_events;
  delete from public.vehicle_stays;
  delete from public.vehicles;

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

  delete from public.optimization_job_events;
  delete from public.optimization_jobs;
  delete from public.ai_dispatch_sessions;
  delete from public.ai_dispatch_plans;

  delete from public.worker_daily_presence;
  delete from public.worker_live_locations;
  delete from public.miniapp_access_sessions;
  delete from public.telegram_conversation_sessions;
  delete from public.telegram_access_requests;
  delete from public.user_admin_events;
  delete from public.audit_events;
  delete from public.performance_report_dispatches;

  -- Remove identities from the previous parking, preserving only the executing Owner.
  update public.app_users set approved_by=null,disabled_by=null where telegram_user_id=p_owner_id;
  delete from public.app_users where telegram_user_id<>p_owner_id;
  delete from public.workers where telegram_user_id is distinct from p_owner_id;
  delete from public.telegram_users where telegram_user_id<>p_owner_id;

  -- Installation-specific physical configuration must not leak into the next parking.
  -- The configuration row is preserved structurally but returned to its safe defaults.
  delete from public.parking_sectors;
  insert into public.parking_config(
    id,parking_name,configured,center_lat,center_lng,
    default_accuracy_threshold_m,updated_by,updated_at,config_notes
  )
  values(true,'Parking',false,null,null,15,null,now(),null)
  on conflict (id) do update set
    parking_name=excluded.parking_name,
    configured=excluded.configured,
    center_lat=excluded.center_lat,
    center_lng=excluded.center_lng,
    default_accuracy_threshold_m=excluded.default_accuracy_threshold_m,
    updated_by=excluded.updated_by,
    updated_at=excluded.updated_at,
    config_notes=excluded.config_notes;

  update public.factory_reset_runs
  set status='completed',
      storage_objects_deleted=greatest(coalesce(p_storage_objects_deleted,0),0),
      completed_at=now(),
      error=null
  where id=p_reset_id;

  select jsonb_build_object(
    'completed',true,
    'reset_id',p_reset_id,
    'storage_objects_deleted',greatest(coalesce(p_storage_objects_deleted,0),0),
    'owner_preserved',(select count(*) from public.telegram_users where telegram_user_id=p_owner_id and role='owner'),
    'vehicles_remaining',(select count(*) from public.vehicles),
    'bookings_remaining',(select count(*) from public.parking_bookings),
    'evidence_metadata_remaining',(select count(*) from public.vehicle_evidence),
    'parking_configured',(select configured from public.parking_config where id=true),
    'parking_sectors_remaining',(select count(*) from public.parking_sectors)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.factory_reset_preview(bigint) from public,anon,authenticated;
revoke all on function public.factory_reset_finalize(uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.factory_reset_preview(bigint) to service_role;
grant execute on function public.factory_reset_finalize(uuid,bigint,integer) to service_role;

commit;
