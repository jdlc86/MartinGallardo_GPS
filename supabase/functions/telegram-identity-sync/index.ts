// Deployed as Supabase Edge Function `telegram-identity-sync`.
// Telegram initData is validated server-side. For an active telegram_user_id,
// the current Telegram username/first_name/last_name are copied to telegram_users
// and workers.full_name is refreshed from first_name + last_name (falling back to @username).
// See the deployed function for the production implementation.
