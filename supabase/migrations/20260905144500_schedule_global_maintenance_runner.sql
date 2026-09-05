-- Replace the first maintenance-specific cron with one global maintenance runner.
select cron.unschedule('aborted-provisional-vehicle-cleanup');

select cron.schedule(
  'global-maintenance-runner',
  '20 3 * * *',
  $$
  select net.http_post(
    url:='https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/maintenance-runner',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-maintenance-secret',(select decrypted_secret from vault.decrypted_secrets where name='maintenance_runner_secret')
    ),
    body:='{}'::jsonb,
    timeout_milliseconds:=30000
  );
  $$
);
