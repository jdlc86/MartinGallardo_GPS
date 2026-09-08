-- Authenticate the privileged performance-report sender and keep the existing
-- hourly scheduler behavior. The shared maintenance secret is read from
-- Supabase Vault at execution time and is never stored in source control.

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'performance-reports-hourly'
  ) then
    perform cron.unschedule('performance-reports-hourly');
  end if;
end
$$;

select cron.schedule(
  'performance-reports-hourly',
  '0 * * * *',
  $cron$
  select net.http_post(
    url := 'https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/performance-report-sender',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-maintenance-secret',
      (select decrypted_secret
       from vault.decrypted_secrets
       where name = 'maintenance_runner_secret')
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $cron$
);
