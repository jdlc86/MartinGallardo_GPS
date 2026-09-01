create or replace function public.broadcast_reservation_notification_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object('changed', true),
    'changed',
    'reservation-notifications',
    false
  );
  return null;
end;
$$;

revoke all on function public.broadcast_reservation_notification_change() from public, anon, authenticated;
grant execute on function public.broadcast_reservation_notification_change() to service_role;

drop trigger if exists parking_booking_notifications_realtime_change
  on public.parking_booking_notifications;

create trigger parking_booking_notifications_realtime_change
after insert or update of read_at, telegram_sent_at, telegram_error
on public.parking_booking_notifications
for each statement
execute function public.broadcast_reservation_notification_change();
