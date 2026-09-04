import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS_JSON = Deno.env.get("SUPABASE_SECRET_KEYS");
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ORIGIN = "https://jdlc86.github.io";

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function serviceKey() {
  if (SECRET_KEYS_JSON) {
    try {
      const parsed = JSON.parse(SECRET_KEYS_JSON);
      if (typeof parsed?.default === "string") return parsed.default;
      const first = Object.values(parsed || {})[0];
      if (typeof first === "string") return first;
    } catch {
      // fallback below
    }
  }
  if (LEGACY_SERVICE_ROLE_KEY) return LEGACY_SERVICE_ROLE_KEY;
  throw new AppError("no_server_key", 500);
}

function headers(extra: Record<string, string> = {}) {
  const key = serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(key: Uint8Array | string, message: string) {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

function fromHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function authenticate(initData: string) {
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get("hash") || "";
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const calculated = await hmac(await hmac("WebAppData", BOT_TOKEN), checkString);
  const supplied = fromHex(suppliedHash);
  if (!supplied || !constantTimeEqual(calculated, supplied)) throw new AppError("invalid_init_data", 403);
  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) throw new AppError("expired_init_data", 403);
  let telegramUser: any = null;
  try { telegramUser = JSON.parse(params.get("user") || "null"); } catch { /* invalid below */ }
  const actor = Number(telegramUser?.id);
  if (!Number.isFinite(actor)) throw new AppError("missing_user", 403);
  return actor;
}

async function rest(path: string, method = "GET", body?: unknown, query?: Record<string, string>) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: headers({
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(method === "POST" ? { Prefer: "return=representation" } : {}),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new AppError(text || "db_error", res.status === 409 ? 409 : 500);
  return text ? JSON.parse(text) : null;
}

const rpc = (name: string, body: unknown) => rest(`rpc/${name}`, "POST", body);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const origin = req.headers.get("Origin");
    if (origin && origin !== ORIGIN) throw new AppError("origin_not_allowed", 403);
    const body = await req.json();
    const actor = await authenticate(String(body.initData || ""));
    const action = String(body.action || "");

    if (action === "enqueue") {
      const epoch = Number(body.writer_epoch);
      await rpc("parking_booking_require_writer", { p_actor_telegram_user_id: actor, p_writer_epoch: epoch });
      const cfg = (await rest("ai_dispatch_config", "GET", undefined, { id: "eq.1", select: "default_horizon_days" }))[0] || {};
      const days = Math.min(Math.max(Number(body.horizon_days) || Number(cfg.default_horizon_days) || 7, 1), 31);
      const start = new Date();
      const end = new Date(+start + days * 86400000);
      const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
      try {
        const rows = await rest("optimization_jobs", "POST", {
          created_by_telegram_user_id: actor,
          writer_epoch: epoch,
          idempotency_key: idempotencyKey,
          status: "pending",
          solver_version: "optimizer_v2_cp_sat",
          horizon_start: start.toISOString(),
          horizon_end: end.toISOString(),
          request: { horizon_days: days, source: "miniapp" },
        });
        return response({ ok: true, job: rows[0], queued: true }, 202);
      } catch (error) {
        if ((error as AppError).status !== 409) throw error;
        const rows = await rest("optimization_jobs", "GET", undefined, {
          created_by_telegram_user_id: `eq.${actor}`,
          idempotency_key: `eq.${idempotencyKey}`,
          select: "*",
          limit: "1",
        });
        return response({ ok: true, job: rows[0], queued: false, idempotent: true });
      }
    }

    if (action === "latest") {
      const rows = await rest("optimization_jobs", "GET", undefined, {
        created_by_telegram_user_id: `eq.${actor}`,
        select: "id,status,solver_version,horizon_start,horizon_end,progress,metrics,result_plan_id,error_code,attempt,max_attempts,started_at,finished_at,created_at,updated_at",
        order: "created_at.desc",
        limit: "1",
      });
      if (!rows.length) return response({ ok: true, job: null, proposal: null });
      const job = rows[0];
      let proposal = null;
      if (job.status === "succeeded" && job.result_plan_id) {
        const plans = await rest("ai_dispatch_plans", "GET", undefined, {
          id: `eq.${job.result_plan_id}`,
          created_by_telegram_user_id: `eq.${actor}`,
          select: "id,status,solver_engine,horizon_start,horizon_end,plan,reports,created_at",
          limit: "1",
        });
        if (plans.length && plans[0].status === "proposal") {
          proposal = {
            plan_id: plans[0].id,
            status: plans[0].status,
            solver_engine: plans[0].solver_engine,
            horizon_start: plans[0].horizon_start,
            horizon_end: plans[0].horizon_end,
            created_at: plans[0].created_at,
            ...(plans[0].plan || {}),
            reports: plans[0].reports || {},
          };
          const unassigned = Array.isArray(proposal.unassigned) ? proposal.unassigned : [];
          const ids = unassigned.map((row: any) => String(row.task_id || "")).filter(Boolean);
          if (ids.length) {
            const taskRows = await rest("reservation_tasks", "GET", undefined, {
              id: `in.(${ids.join(",")})`,
              select: "id,task_type,scheduled_at,parking_bookings!inner(vehicle_plate,customer_name,pickup_terminal,return_terminal)",
            });
            const taskMeta = Object.fromEntries(taskRows.map((row: any) => [String(row.id), row]));
            proposal.unassigned = unassigned.map((row: any) => {
              const meta = taskMeta[String(row.task_id)] || {};
              const booking = meta.parking_bookings || {};
              return {
                ...row,
                task_type: row.task_type || meta.task_type,
                scheduled_at: row.scheduled_at || meta.scheduled_at,
                plate: booking.vehicle_plate || null,
                customer_name: booking.customer_name || null,
              };
            });
          }
        }
      }
      return response({ ok: true, job, proposal });
    }

    if (action === "status") {
      const jobId = String(body.job_id || "");
      if (!jobId) throw new AppError("job_id_required");
      const rows = await rest("optimization_jobs", "GET", undefined, {
        id: `eq.${jobId}`,
        created_by_telegram_user_id: `eq.${actor}`,
        select: "id,status,solver_version,horizon_start,horizon_end,progress,metrics,result_plan_id,error_code,attempt,max_attempts,started_at,finished_at,created_at,updated_at",
        limit: "1",
      });
      if (!rows.length) throw new AppError("job_not_found", 404);
      const job = rows[0];
      let proposal = null;
      if (job.status === "succeeded" && job.result_plan_id) {
        const plans = await rest("ai_dispatch_plans", "GET", undefined, {
          id: `eq.${job.result_plan_id}`,
          created_by_telegram_user_id: `eq.${actor}`,
          select: "id,status,solver_engine,horizon_start,horizon_end,plan,reports,created_at",
          limit: "1",
        });
        if (plans.length && plans[0].status === "proposal") {
          proposal = {
            plan_id: plans[0].id,
            status: plans[0].status,
            solver_engine: plans[0].solver_engine,
            horizon_start: plans[0].horizon_start,
            horizon_end: plans[0].horizon_end,
            created_at: plans[0].created_at,
            ...(plans[0].plan || {}),
            reports: plans[0].reports || {},
          };
          const unassigned = Array.isArray(proposal.unassigned) ? proposal.unassigned : [];
          const ids = unassigned.map((row: any) => String(row.task_id || "")).filter(Boolean);
          if (ids.length) {
            const taskRows = await rest("reservation_tasks", "GET", undefined, {
              id: `in.(${ids.join(",")})`,
              select: "id,task_type,scheduled_at,parking_bookings!inner(vehicle_plate,customer_name,pickup_terminal,return_terminal)",
            });
            const taskMeta = Object.fromEntries(taskRows.map((row: any) => [String(row.id), row]));
            proposal.unassigned = unassigned.map((row: any) => {
              const meta = taskMeta[String(row.task_id)] || {};
              const booking = meta.parking_bookings || {};
              return {
                ...row,
                task_type: row.task_type || meta.task_type,
                scheduled_at: row.scheduled_at || meta.scheduled_at,
                plate: booking.vehicle_plate || null,
                customer_name: booking.customer_name || null,
              };
            });
          }
        }
      }
      return response({ ok: true, job, proposal });
    }

    if (action === "cancel") {
      const jobId = String(body.job_id || "");
      if (!jobId) throw new AppError("job_id_required");
      const ok = await rpc("cancel_optimization_job", { p_job_id: jobId, p_actor_telegram_user_id: actor });
      return response({ ok: true, cancelled_or_requested: Boolean(ok) });
    }

    throw new AppError("invalid_action");
  } catch (error) {
    console.error(error);
    const appError = error as AppError;
    return response({ ok: false, error: String(appError?.message || error) }, appError?.status || 500);
  }
});
