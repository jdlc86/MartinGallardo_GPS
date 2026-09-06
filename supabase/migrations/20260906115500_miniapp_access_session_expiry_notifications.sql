create table if not exists public.miniapp_access_sessions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  auth_date timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  active boolean not null default true,
  unique (telegram_user_id, auth_date)
);

alter table public.miniapp_access_sessions enable row level security;
revoke all on table public.miniapp_access_sessions from anon, authenticated;

create index if not exists miniapp_access_sessions_expiry_idx
  on public.miniapp_access_sessions (expires_at)
  where active = true and notified_at is null;

create or replace function public.emit_miniapp_access_session_expiry_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  with expired as (
    update public.miniapp_access_sessions s
       set notified_at = now(),
           active = false,
           last_seen_at = now()
     where s.active = true
       and s.notified_at is null
       and s.expires_at <= now()
    returning s.id, s.telegram_user_id, s.auth_date, s.expires_at
  ), inserted as (
    insert into public.parking_booking_notifications (
      recipient_telegram_user_id,
      notification_type,
      title,
      body,
      payload
    )
    select
      e.telegram_user_id,
      'access_session_expired',
      'Sesión de ParkingMartin-G caducada',
      'Tu sesión de acceso ha caducado. Cierra la sesión anterior y utiliza el botón inferior para volver a entrar de forma segura.',
      jsonb_build_object(
        'access_session_id', e.id,
        'auth_date', e.auth_date,
        'expired_at', e.expires_at
      )
    from expired e
    returning 1
  )
  select count(*)::integer into v_count from inserted;

  return v_count;
end;
$function$;

revoke all on function public.emit_miniapp_access_session_expiry_notifications() from public, anon, authenticated;

create or replace function public.emit_session_expiry_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operations integer := 0;
  v_access integer := 0;
begin
  v_operations := public.emit_operation_flow_expiry_warnings();
  v_access := public.emit_miniapp_access_session_expiry_notifications();
  return coalesce(v_operations,0) + coalesce(v_access,0);
end;
$function$;

revoke all on function public.emit_session_expiry_notifications() from public, anon, authenticated;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname='operation-flow-expiry-warnings' limit 1;
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
  if not exists (select 1 from cron.job where jobname='session-expiry-notifications') then
    perform cron.schedule(
      'session-expiry-notifications',
      '* * * * *',
      'select public.emit_session_expiry_notifications();'
    );
  end if;
end $$;
