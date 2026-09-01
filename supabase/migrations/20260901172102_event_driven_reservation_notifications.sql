select cron.unschedule(jobid)
from cron.job
where jobname = 'deliver-reservation-notifications';

create or replace function public.dispatch_reservation_notification_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret
  into v_secret
  from vault.decrypted_secrets
  where name = 'reservation_notification_cron_secret'
  limit 1;

  if coalesce(length(v_secret), 0) < 32 then
    raise warning 'reservation notification delivery secret is unavailable';
    return null;
  end if;

  perform net.http_post(
    url := 'https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-notification-sender',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-PMG-Cron-Secret', v_secret
    ),
    body := jsonb_build_object('source', 'notification_insert'),
    timeout_milliseconds := 30000
  );
  return null;
exception
  when others then
    raise warning 'reservation notification delivery event failed: %', sqlerrm;
    return null;
end;
$$;

revoke all on function public.dispatch_reservation_notification_delivery()
  from public, anon, authenticated;
grant execute on function public.dispatch_reservation_notification_delivery()
  to service_role;

drop trigger if exists parking_booking_notifications_delivery_event
  on public.parking_booking_notifications;

create trigger parking_booking_notifications_delivery_event
after insert
on public.parking_booking_notifications
for each statement
execute function public.dispatch_reservation_notification_delivery();

drop trigger if exists parking_booking_notifications_realtime_change
  on public.parking_booking_notifications;

create trigger parking_booking_notifications_realtime_change
after insert or update of read_at
on public.parking_booking_notifications
for each statement
execute function public.broadcast_reservation_notification_change();
