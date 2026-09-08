-- Remove plan-tier wording from the daily database health report.
-- This changes presentation only: quota bytes, thresholds, recipients and cron behavior remain unchanged.

update public.database_health_config
set quota_source = '500 MB'
where id = true;

create or replace function public.emit_daily_database_health_report(
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cfg public.database_health_config%rowtype;
  v_local_now timestamp;
  v_report_date date;
  v_db_size bigint;
  v_quota bigint;
  v_remaining bigint;
  v_used_pct numeric;
  v_open_connections integer;
  v_active_connections integer;
  v_max_connections integer;
  v_connection_pct numeric;
  v_long_queries integer;
  v_dead_tuples bigint;
  v_pending_notifications integer;
  v_active_flows integer;
  v_bookings integer;
  v_tasks integer;
  v_top_table text;
  v_top_table_bytes bigint;
  v_status text := 'ok';
  v_status_icon text := '✅';
  v_body text;
  v_metrics jsonb;
  v_recipients integer := 0;
begin
  select * into v_cfg
  from public.database_health_config
  where id = true;

  if not found then
    raise exception 'database_health_config_missing';
  end if;

  v_local_now := now() at time zone v_cfg.timezone;
  v_report_date := v_local_now::date;

  -- pg_cron runs in UTC. The job fires hourly and this guard makes the
  -- effective report run exactly once at local midnight in Europe/Madrid,
  -- including daylight-saving changes.
  if not p_force and extract(hour from v_local_now)::integer <> 0 then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'outside_local_midnight',
      'local_time', v_local_now
    );
  end if;

  if not p_force and exists (
    select 1 from public.database_health_reports where report_date = v_report_date
  ) then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'already_reported',
      'report_date', v_report_date
    );
  end if;

  v_db_size := pg_database_size(current_database());
  v_quota := v_cfg.database_quota_bytes;
  v_remaining := greatest(v_quota - v_db_size, 0);
  v_used_pct := round((v_db_size::numeric * 100) / nullif(v_quota, 0), 2);

  select count(*)::integer,
         count(*) filter (where state = 'active')::integer
  into v_open_connections, v_active_connections
  from pg_stat_activity
  where datname = current_database();

  v_max_connections := current_setting('max_connections')::integer;
  v_connection_pct := round((v_open_connections::numeric * 100) / nullif(v_max_connections, 0), 2);

  select count(*)::integer
  into v_long_queries
  from pg_stat_activity
  where datname = current_database()
    and state = 'active'
    and backend_type = 'client backend'
    and pid <> pg_backend_pid()
    and query_start < now() - interval '5 minutes';

  select coalesce(sum(n_dead_tup), 0)::bigint
  into v_dead_tuples
  from pg_stat_user_tables;

  select count(*)::integer
  into v_pending_notifications
  from public.parking_booking_notifications
  where telegram_sent_at is null
    and telegram_attempts < 8;

  select count(*)::integer
  into v_active_flows
  from public.operation_flow_sessions
  where status = 'active'
    and expires_at > now();

  select count(*)::integer into v_bookings from public.parking_bookings;
  select count(*)::integer into v_tasks from public.reservation_tasks;

  select relname, pg_total_relation_size(relid)
  into v_top_table, v_top_table_bytes
  from pg_catalog.pg_statio_user_tables
  order by pg_total_relation_size(relid) desc
  limit 1;

  if v_used_pct >= v_cfg.critical_percent or v_connection_pct >= 90 then
    v_status := 'critical';
    v_status_icon := '🚨';
  elsif v_used_pct >= v_cfg.warning_percent
     or v_connection_pct >= 80
     or v_long_queries > 0
     or v_pending_notifications > 10 then
    v_status := 'warning';
    v_status_icon := '⚠️';
  end if;

  v_metrics := jsonb_build_object(
    'timezone', v_cfg.timezone,
    'database_size_bytes', v_db_size,
    'database_quota_bytes', v_quota,
    'database_remaining_bytes', v_remaining,
    'database_used_percent', v_used_pct,
    'quota_source', v_cfg.quota_source,
    'open_connections', v_open_connections,
    'active_connections', v_active_connections,
    'max_connections', v_max_connections,
    'connection_used_percent', v_connection_pct,
    'long_queries_over_5m', v_long_queries,
    'dead_tuples', v_dead_tuples,
    'pending_telegram_notifications', v_pending_notifications,
    'active_operation_flows', v_active_flows,
    'bookings', v_bookings,
    'tasks', v_tasks,
    'largest_table', v_top_table,
    'largest_table_bytes', coalesce(v_top_table_bytes, 0)
  );

  insert into public.database_health_reports(report_date, generated_at, status, metrics)
  values(v_report_date, now(), v_status, v_metrics)
  on conflict (report_date) do update
    set generated_at = excluded.generated_at,
        status = excluded.status,
        metrics = excluded.metrics;

  v_body :=
    v_status_icon || ' Estado: ' || upper(v_status) || E'\n'
    || '📦 Base de datos: ' || round(v_db_size::numeric / 1048576, 1) || ' MB / '
       || round(v_quota::numeric / 1048576, 0) || ' MB (' || v_used_pct || '%)' || E'\n'
    || '💾 Espacio restante: ' || round(v_remaining::numeric / 1048576, 1) || ' MB' || E'\n'
    || '🔌 Conexiones: ' || v_open_connections || '/' || v_max_connections
       || ' · activas ' || v_active_connections || E'\n'
    || '⏱ Consultas >5 min: ' || v_long_queries || E'\n'
    || '🧹 Tuplas muertas: ' || v_dead_tuples || E'\n'
    || '📨 Notificaciones pendientes: ' || v_pending_notifications || E'\n'
    || '🚗 Flujos operativos activos: ' || v_active_flows || E'\n'
    || '📋 Reservas / tareas: ' || v_bookings || ' / ' || v_tasks || E'\n'
    || '📚 Tabla mayor: ' || coalesce(v_top_table, '—') || ' · '
       || round(coalesce(v_top_table_bytes,0)::numeric / 1048576, 1) || ' MB' || E'\n\n'
    || 'Límite configurado: ' || v_cfg.quota_source || E'\n'
    || 'Informe: ' || to_char(v_local_now, 'DD/MM/YYYY HH24:MI') || ' · ' || v_cfg.timezone;

  insert into public.parking_booking_notifications(
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  select
    u.telegram_user_id,
    'database_health_daily',
    'Salud diaria de ParkingMartin-G',
    v_body,
    jsonb_build_object(
      'report_date', v_report_date,
      'status', v_status,
      'metrics', v_metrics
    )
  from public.telegram_users u
  where u.active = true
    and u.role in ('owner','admin');

  get diagnostics v_recipients = row_count;

  return jsonb_build_object(
    'ok', true,
    'report_date', v_report_date,
    'status', v_status,
    'recipients', v_recipients,
    'metrics', v_metrics
  );
end
$function$;


revoke all on function public.emit_daily_database_health_report(boolean)
  from public, anon, authenticated;
grant execute on function public.emit_daily_database_health_report(boolean)
  to service_role;
