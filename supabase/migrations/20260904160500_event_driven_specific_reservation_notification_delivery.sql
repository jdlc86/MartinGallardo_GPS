create or replace function public.parking_booking_claim_telegram_notification(p_notification_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.parking_booking_notifications%rowtype;
begin
  select * into v_row
  from public.parking_booking_notifications
  where id = p_notification_id
  for update;

  if not found or v_row.telegram_sent_at is not null or v_row.telegram_attempts >= 8 then return null; end if;
  if v_row.telegram_claimed_at is not null and v_row.telegram_claimed_at >= now() - interval '5 minutes' then return null; end if;

  update public.parking_booking_notifications
  set telegram_claimed_at = now(), telegram_attempts = telegram_attempts + 1, telegram_error = null
  where id = p_notification_id
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'recipient_telegram_user_id', v_row.recipient_telegram_user_id,
    'title', v_row.title,
    'body', v_row.body,
    'notification_type', v_row.notification_type,
    'permission_request_id', v_row.permission_request_id
  );
end;
$$;

revoke all on function public.parking_booking_claim_telegram_notification(bigint) from public, anon, authenticated;
grant execute on function public.parking_booking_claim_telegram_notification(bigint) to service_role;

create or replace function public.dispatch_reservation_notification_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'reservation_notification_cron_secret'
  limit 1;

  if coalesce(length(v_secret),0) < 32 then return new; end if;

  perform net.http_post(
    url := 'https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-notification-sender',
    headers := jsonb_build_object('Content-Type','application/json','X-PMG-Cron-Secret',v_secret),
    body := jsonb_build_object('source','notification_insert','notification_id',new.id),
    timeout_milliseconds := 30000
  );
  return new;
exception when others then
  raise warning 'reservation notification delivery event failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists parking_booking_notifications_delivery_event on public.parking_booking_notifications;
create trigger parking_booking_notifications_delivery_event
after insert on public.parking_booking_notifications
for each row execute function public.dispatch_reservation_notification_delivery();
