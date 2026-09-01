do $$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'reservation_notification_cron_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'reservation_notification_cron_secret',
      'Authenticates the reservation notification cron sender'
    );
  end if;
end;
$$;

create or replace function public.validate_reservation_notification_cron_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'reservation_notification_cron_secret'
      and decrypted_secret = p_secret
  );
$$;

revoke all on function public.validate_reservation_notification_cron_secret(text)
  from public, anon, authenticated;
grant execute on function public.validate_reservation_notification_cron_secret(text)
  to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'deliver-reservation-notifications';

select cron.schedule(
  'deliver-reservation-notifications',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/reservation-notification-sender',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-PMG-Cron-Secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'reservation_notification_cron_secret'
          limit 1
        )
      ),
      body := '{"source":"cron"}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
