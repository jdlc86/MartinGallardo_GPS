-- Factory Reset must remain compatible with the database safe-delete guard.
-- The guard rejects DELETE statements without a WHERE clause, even inside
-- this owner-only SECURITY DEFINER reset function. WHERE true preserves the
-- intended full-table operational purge while making that intent explicit.

create or replace function public.factory_reset_finalize(
  p_reset_id uuid,
  p_owner_id bigint,
  p_storage_objects_deleted integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  delete from public.operation_flow_sessions where true;
  delete from public.plate_verifications where true;
  delete from public.vehicle_photos where true;
  delete from public.vehicle_evidence where true;
  delete from public.vehicle_share_links where true;
  delete from public.vehicle_disputes where true;
  delete from public.parking_events where true;
  delete from public.vehicle_stays where true;
  delete from public.vehicles where true;

  delete from public.reservation_task_assignment_history where true;
  delete from public.reservation_tasks where true;
  delete from public.parking_booking_notifications where true;
  delete from public.parking_booking_admin_events where true;
  delete from public.parking_booking_permission_requests where true;
  delete from public.parking_booking_command_dedup where true;
  delete from public.parking_booking_write_state where true;
  delete from public.parking_bookings where true;
  delete from public.parking_booking_import_batches where true;
  delete from public.parking_booking_import_analyses where true;

  delete from public.optimization_job_events where true;
  delete from public.optimization_jobs where true;
  delete from public.ai_dispatch_sessions where true;
  delete from public.ai_dispatch_plans where true;

  delete from public.worker_daily_presence where true;
  delete from public.worker_live_locations where true;
  delete from public.miniapp_access_sessions where true;
  delete from public.telegram_conversation_sessions where true;
  delete from public.telegram_access_requests where true;
  delete from public.user_admin_events where true;
  delete from public.audit_events where true;
  delete from public.performance_report_dispatches where true;

  update public.app_users set approved_by=null,disabled_by=null where telegram_user_id=p_owner_id;
  delete from public.app_users where telegram_user_id<>p_owner_id;
  delete from public.workers where telegram_user_id is distinct from p_owner_id;
  delete from public.telegram_users where telegram_user_id<>p_owner_id;

  delete from public.parking_sectors where true;
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
$function$;
