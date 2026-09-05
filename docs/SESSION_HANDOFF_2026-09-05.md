# Session handoff — 2026-09-05

## Priority 1 for next session
Resolve the **Equipo en vivo** failure that appears after the Telegram Mini App has been open for a while.

### Symptom
In `docs/preview-modern/team-live.html`, the user sees:
> No se pudieron actualizar las ubicaciones del equipo. Inténtalo de nuevo en unos segundos.

Internet is actually available.

### Confirmed facts
- `connectivity-health` responds 200 when the error appears.
- `modern-live-team-api` CORS preflight responds 204.
- `team-live.html` polls `modern-live-team-api` every 10 seconds.
- The API authenticates every request using `Telegram.WebApp.initData`.
- The API currently rejects `initData` older than 900 seconds (15 minutes):
  `Math.abs(Date.now()/1000-at)>900 => expired_init_data`.
- Therefore, a long-open Mini App can start failing even though Internet and Supabase are healthy.
- Do NOT hide the error. Fix the session/auth model for long-lived read operations.
- The user explicitly wants to start the next session by solving this problem.

### Desired product behavior
- Equipo en vivo must remain usable for a long-running Mini App session (hours, potentially a full shift).
- Internet loss, backend outage, and expired Telegram auth must be treated as distinct causes.
- Avoid asking the user to close/reopen the Mini App every 15 minutes.
- Preserve strong Telegram/worker authorization.
- Prefer a short-lived server-issued read session/token or another secure long-lived session mechanism rather than simply increasing initData validity blindly.
- Keep the existing map rule: only workers actively sharing location are shown.

## Current Equipo en vivo architecture
Frontend:
- `docs/preview-modern/team-live.html`
- Calls `modern-live-team-api` every 10 s.
- Current map filters are provided by backend.

Backend:
- `supabase/functions/modern-live-team-api/index.ts`
- Restored from retired endpoint.
- Version live: v7 at the time of handoff.
- Reads `worker_live_locations`.
- Only returns rows with `live_until > now()`.
- Strong Telegram initData validation + active telegram_user + active worker check.
- Critical Edge Function with release attestation.

Location ingestion:
- `supabase/functions/telegram-gateway/index.ts`
- Saves live location into `worker_live_locations`.
- When Telegram reports edited live location with `live_period = 0`, it deletes that worker's row immediately.
- Therefore, stopped sharing should disappear from the map.
- Expired rows are also hidden by `live_until > now()`.

## Connectivity work already completed
New global connectivity model:
- `docs/preview-modern/offline-runtime.js` v4
- `supabase/functions/connectivity-health/index.ts`
- `docs/preview-modern/connectivity-ping.txt`
- SW cache around this work: `pmg-shell-v55` before later visual nav changes.
States:
1. offline: static app resource cannot be reached
2. backend_down: app resource works but Supabase health endpoint fails
3. online: both work
A single failed fetch no longer automatically means “no Internet”.

## Navigation / appearance status
The navigation header was modernized:
- `docs/preview-modern/navigation-runtime.js` v4
- Approved visual pattern first on Vehículos, then extended to normal screens.
- Minimal SVG back arrow + centered page title + minimal SVG home icon
- sticky, translucent, blur, compact-on-scroll
- No business/navigation logic was intentionally changed by this visual pass
- Protected flows keep their own flow headers:
  - park
  - pickup
  - relocate
  - delivery
  - search
Latest visual rollout commit before this handoff:
- `6b3b7fc220e6e62ac97eafb218ea355bbc98ab72`
- SW cache: `pmg-shell-v57`
- Stable Release Guard #115 passed

## Android back behavior
Important product decision:
- On normal screens, physical Android Back should behave natively / return toward Telegram; in-app top controls handle internal navigation.
- Protected operation flows may intercept Back to preserve/cancel session safely.
- Vehicles was specifically corrected as the reference behavior.
- Operations was aligned afterward.

## Operation flow integrity
Strong flow-session protection exists for:
- Aparcar
- Entrega
- Recogida
- Reubicar
- Buscar coche (lighter read-only context)

Important anti-mixing design:
- session binds worker + telegram user + plate + vehicle (+ task where applicable)
- verification IDs must belong to the same session
- changing plate/context mid-flow is rejected
- backend finalizers are transactional/idempotent where needed
- friendly integrity error gives restart/cancel

Recogida:
- evidence, documentation, OCR verification scoped by `flow_session_id`
- finalizer `complete_pickup_flow`

Reubicar:
- stores expected vehicle `updated_at`
- rejects stale session if vehicle changed before confirmation
- finalizer `complete_relocate_flow`

## Cleanup / maintenance architecture
Business rule clarified by user:
- aborted session is technical state, not business history
- never delete consolidated business history
- cleanup only removes data originating from aborted technical sessions
- if vehicle itself is provisional and has no consolidated business state/history, it may be deleted
- if vehicle pre-existed / has business history, never delete the vehicle because a later flow was aborted

Defense in depth:
- cleanup requires cancelled PARK session with `vehicle_created_by_session=true` before deleting a provisional vehicle

Global maintenance architecture:
`global cron -> maintenance-runner -> registered maintenance tasks`

Tables:
- `maintenance_tasks`
- `maintenance_runner_runs`

Current registered task:
- `cleanup_aborted_flows -> aborted-vehicle-cleanup`

Cron:
- `global-maintenance-runner`
- daily 03:20 UTC
- previous specific `aborted-provisional-vehicle-cleanup` cron was removed

## Recent important backend functions
Critical/live functions involved in recent work:
- modern-parking-api
- modern-pickup-api
- modern-relocate-api
- modern-delivery-api
- modern-search-api
- modern-live-team-api
- connectivity-health
- maintenance-runner
- aborted-vehicle-cleanup
- telegram-gateway

## Release discipline
Do not deploy backend changes without:
1. source in GitHub
2. `RELEASE_SOURCE_REVISION` updated
3. release/manifest attestation updated if critical
4. Stable Release Guard green
5. deploy exact GitHub source to Supabase
6. verify live source / deployed release when applicable

## First technical action next session
Inspect the long-lived auth problem in `modern-live-team-api`.

Recommended direction:
- Use Telegram `initData` only to bootstrap a secure server-issued read session/token.
- Store token server-side or sign it with an expiring server secret.
- Bind it to telegram_user_id/worker_id and intended scope (`team_live_read`).
- Token lifetime should cover an operational shift (e.g. several hours), with controlled renewal while the Mini App is active.
- Do not use a permanent bearer token in frontend.
- Do not simply remove freshness checks from Telegram initData without analyzing replay risk.
- Keep CORS restricted to the GitHub Pages origin.
- After implementing, test:
  1. open Team Live
  2. verify immediate load
  3. simulate/verify auth older than 15 min
  4. ensure polling continues
  5. stop worker live sharing -> marker disappears
  6. real internet off -> offline state
  7. backend unavailable -> backend_down state
  8. reconnect -> recover automatically

