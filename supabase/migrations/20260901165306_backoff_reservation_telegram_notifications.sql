create or replace function public.parking_booking_finish_telegram_notification(
  p_notification_id bigint,
  p_success boolean,
  p_error text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.parking_booking_notifications
  set telegram_sent_at = case when p_success then now() else telegram_sent_at end,
      telegram_claimed_at = case when p_success then null else now() end,
      telegram_error = case
        when p_success then null
        else left(coalesce(p_error, 'telegram_error'), 500)
      end
  where id = p_notification_id;
end;
$$;

revoke all on function public.parking_booking_finish_telegram_notification(bigint, boolean, text)
  from public, anon, authenticated;
grant execute on function public.parking_booking_finish_telegram_notification(bigint, boolean, text)
  to service_role;
