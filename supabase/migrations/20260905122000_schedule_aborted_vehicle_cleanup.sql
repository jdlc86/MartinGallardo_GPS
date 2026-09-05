-- Schedule safe cleanup of aborted provisional vehicles.
-- The authentication secret is read from Supabase Vault at runtime and is never stored in source control.
select cron.schedule(
  'aborted-provisional-vehicle-cleanup',
  '20 3 * * *',
  $$
  select net.http_post(
    url:='https://mvexykcxnpaywkbnoxwu.supabase.co/functions/v1/aborted-vehicle-cleanup',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-cleanup-secret',(select decrypted_secret from vault.decrypted_secrets where name='aborted_vehicle_cleanup_secret')
    ),
    body:='{"limit":25}'::jsonb,
    timeout_milliseconds:=20000
  );
  $$
);
