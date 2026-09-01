create index if not exists parking_booking_notifications_created_at_idx
  on public.parking_booking_notifications(created_at);

create or replace function public.parking_booking_cleanup_notifications()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.parking_booking_notifications
  where created_at < now() - interval '90 days';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.parking_booking_cleanup_notifications()
  from public, anon, authenticated;
grant execute on function public.parking_booking_cleanup_notifications()
  to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cleanup-reservation-notifications';

select cron.schedule(
  'cleanup-reservation-notifications',
  '35 2 * * *',
  $$select public.parking_booking_cleanup_notifications();$$
);
