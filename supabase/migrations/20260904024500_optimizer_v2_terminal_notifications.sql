-- Optimizer V2: notify only the user who launched a terminal job.
-- Reuses parking_booking_notifications so Telegram delivery and Realtime
-- broadcast stay on the existing notification infrastructure.

create or replace function public.notify_optimization_job_terminal()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_title text;
  v_body text;
  v_type text;
begin
  if new.status not in ('succeeded','failed') or new.status is not distinct from old.status then
    return null;
  end if;

  if new.status = 'succeeded' then
    v_type := 'optimizer_completed';
    v_title := 'Optimización terminada';
    v_body := format(
      'La propuesta de optimización ha terminado%s. Ya puedes revisarla en la Mini App.',
      case
        when coalesce((new.metrics->>'assigned_count')::text, '') <> ''
          then format(' con %s tareas asignadas', new.metrics->>'assigned_count')
        else ''
      end
    );
  else
    v_type := 'optimizer_failed';
    v_title := 'Optimización no completada';
    v_body := 'La optimización no pudo completarse. Abre la Mini App para revisar el estado.';
  end if;

  insert into public.parking_booking_notifications(
    recipient_telegram_user_id,
    notification_type,
    title,
    body,
    payload
  )
  values(
    new.created_by_telegram_user_id,
    v_type,
    v_title,
    v_body,
    jsonb_build_object(
      'optimization_job_id', new.id,
      'status', new.status,
      'result_plan_id', new.result_plan_id,
      'error_code', new.error_code
    )
  );

  return null;
end;
$$;

drop trigger if exists optimization_jobs_terminal_notification on public.optimization_jobs;
create trigger optimization_jobs_terminal_notification
after update of status on public.optimization_jobs
for each row
when (old.status is distinct from new.status and new.status in ('succeeded','failed'))
execute function public.notify_optimization_job_terminal();

revoke all on function public.notify_optimization_job_terminal() from public, anon, authenticated;
